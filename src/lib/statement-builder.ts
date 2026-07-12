import path from "node:path";
import ts from "typescript";

import {
  getLeafName,
  isValidTopLevelName,
  mangleTopLevelName,
  shouldEmitThisVoidParameter,
  toPropertyName,
  toValidTopLevelName,
  toValidTypeName,
  withCustomNameComment,
} from "./name-utils.js";
import {
  buildFieldTypeNode,
  buildFunctionSignature,
  buildFunctionSignatureFromTypeText,
  createFunctionTypeNodeFromFieldEntry,
  createTypeNodeFromText,
  isFunctionType,
} from "./type-utils.js";
import type {
  MetaClassEntry,
  MetaDocument,
  MetaEnumEntry,
  MetaEnumFieldEntry,
  MetaFieldEntry,
  MetaFnEntry,
  MetaGenericEntry,
  MetaLoc,
} from "./types.js";

export function buildStatementsForDocument(
  metaFile: string,
  document: MetaDocument,
  warnings: string[],
  knownTypeNames: Set<string>,
): ts.Statement[] {
  const typeEntries = Array.isArray(document.types) ? [...document.types] : [];
  typeEntries.sort(
    (left, right) =>
      getLine(left) - getLine(right) || left.name.localeCompare(right.name),
  );

  const classes = typeEntries.filter(
    (entry): entry is MetaClassEntry => entry.type === "class",
  );
  const enums = typeEntries.filter(
    (entry): entry is MetaEnumEntry => entry.type === "enum",
  );
  const classNames = new Set(classes.map((entry) => entry.name));
  const isKnownTypeName = (n: string) =>
    classNames.has(n) || knownTypeNames.has(toValidTypeName(n));
  const globalEntries = Array.isArray(document.globals)
    ? [...document.globals]
    : [];
  globalEntries.sort(
    (left, right) =>
      getLine(left) - getLine(right) || left.name.localeCompare(right.name),
  );
  const topLevelFields = globalEntries.filter(
    (entry): entry is MetaFieldEntry => entry.type === "field",
  );
  const topLevelFns = globalEntries.filter(
    (entry): entry is MetaFnEntry => entry.type === "fn",
  );
  const statements: ts.Statement[] = [];

  type ModuleNode = {
    children: Map<string, ModuleNode>;
    declarations: ts.Statement[];
  };
  const qualifiedRoots = new Map<string, ModuleNode>();

  const ensureRoot = (name: string): ModuleNode => {
    let node = qualifiedRoots.get(name);
    if (!node) {
      node = { children: new Map(), declarations: [] };
      qualifiedRoots.set(name, node);
    }
    return node;
  };

  const ensureChild = (parent: ModuleNode, name: string): ModuleNode => {
    let node = parent.children.get(name);
    if (!node) {
      node = { children: new Map(), declarations: [] };
      parent.children.set(name, node);
    }
    return node;
  };

  const insertQualified = (fullName: string, declaration: ts.Statement) => {
    const segments = fullName.split(".").filter(Boolean);
    if (segments.length === 0) return;
    const root = segments[0];
    if (!root) return;
    const pathSegments = segments.slice(1);
    const rootNode = ensureRoot(root);

    if (pathSegments.length === 0) {
      rootNode.declarations.push(declaration);
      return;
    }

    let node = rootNode;
    for (let i = 0; i < pathSegments.length - 1; i += 1) {
      const segment = pathSegments[i];
      if (!segment) {
        continue;
      }

      node = ensureChild(node, segment);
    }

    node.declarations.push(declaration);
  };

  for (const classEntry of classes) {
    const decl = buildClassDeclaration(classEntry);
    if (classEntry.name.includes(".")) {
      insertQualified(classEntry.name, decl);
    } else {
      statements.push(decl);
    }
  }

  for (const enumEntry of enums) {
    const decl = buildEnumDeclaration(enumEntry);
    if (enumEntry.name.includes(".")) {
      insertQualified(enumEntry.name, decl);
    } else {
      statements.push(decl);
    }
  }

  const fieldGroups = groupByName(
    topLevelFields.filter(
      (entry) => !isKnownTypeName(entry.name) && entry.typ !== undefined,
    ),
  );
  const groupedFieldNames = new Set(fieldGroups.keys());
  for (const [name, entries] of fieldGroups) {
    const first = entries[0];
    if (first === undefined) {
      continue;
    }

    if (entries.every((entry) => isFunctionType(entry.typ))) {
      if (isValidTopLevelName(name)) {
        statements.push(
          ...entries.map((entry) =>
            buildFunctionDeclarationFromField(entry, warnings),
          ),
        );
      } else {
        warnings.push(
          `Renamed invalid global identifier ${name} -> ${mangleTopLevelName(name)}`,
        );
        const functionType = createFunctionTypeNodeFromFieldEntry(first, warnings);
        statements.push(
          createCustomNamedVariableStatement(
            mangleTopLevelName(name),
            functionType,
            name,
          ),
        );
      }
      continue;
    }

    statements.push(buildConstDeclaration(name, first, warnings));
  }

  const functionGroups = groupByName(topLevelFns);
  for (const [name, entries] of functionGroups) {
    if (!isValidTopLevelName(name)) {
      const first = entries[0];
      if (first !== undefined) {
        warnings.push(
          `Renamed invalid global identifier ${name} -> ${mangleTopLevelName(name)}`,
        );
        const signature = buildFunctionSignature(first, true);
        const functionType = ts.factory.createFunctionTypeNode(
          signature.typeParameters.length > 0
            ? signature.typeParameters
            : undefined,
          signature.parameters,
          signature.returnType,
        );
        statements.push(
          createCustomNamedVariableStatement(
            mangleTopLevelName(name),
            functionType,
            name,
          ),
        );
      }
      continue;
    }

    statements.push(...entries.map((entry) => buildFunctionDeclaration(entry)));
  }

  const duplicateFunctionNames = new Set(functionGroups.keys());
  for (const fieldEntry of topLevelFields) {
    if (
      isKnownTypeName(fieldEntry.name) ||
      duplicateFunctionNames.has(fieldEntry.name) ||
      groupedFieldNames.has(fieldEntry.name)
    ) {
      continue;
    }

    if (!fieldEntry.typ) {
      continue;
    }

    if (isFunctionType(fieldEntry.typ)) {
      if (isValidTopLevelName(fieldEntry.name)) {
        statements.push(buildFunctionDeclarationFromField(fieldEntry, warnings));
      } else {
        const mangledName = mangleTopLevelName(fieldEntry.name);
        warnings.push(
          `Renamed invalid global identifier ${fieldEntry.name} -> ${mangledName}`,
        );
        statements.push(
          buildConstDeclaration(
            mangledName,
            { ...fieldEntry, name: mangledName },
            warnings,
            fieldEntry.name,
          ),
        );
      }
      continue;
    }

    if (isValidTopLevelName(fieldEntry.name)) {
      statements.push(buildConstDeclaration(fieldEntry.name, fieldEntry, warnings));
      continue;
    }

    const mangledName = mangleTopLevelName(fieldEntry.name);
    warnings.push(
      `Renamed invalid global identifier ${fieldEntry.name} -> ${mangledName}`,
    );
    statements.push(
      buildConstDeclaration(
        mangledName,
        { ...fieldEntry, name: mangledName },
        warnings,
        fieldEntry.name,
      ),
    );
  }

  if (document.modules && document.modules.length > 0) {
    warnings.push(
      `Ignoring ${document.modules.length} module entries from ${path.basename(metaFile)} because namespace emission is not yet implemented.`,
    );
  }

  const buildModuleFromNode = (
    name: string,
    node: ModuleNode,
    isOutermost: boolean,
  ): ts.ModuleDeclaration => {
    const innerStatements: ts.Statement[] = [];

    innerStatements.push(...node.declarations);

    const childKeys = [...node.children.keys()].sort((a, b) =>
      a.localeCompare(b),
    );
    for (const childKey of childKeys) {
      const childNode = node.children.get(childKey);
      if (!childNode) {
        continue;
      }

      const childModule = buildModuleFromNode(childKey, childNode, false);
      innerStatements.push(childModule);
    }

    const modifiers = isOutermost
      ? [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)]
      : undefined;

    return ts.factory.createModuleDeclaration(
      modifiers,
      ts.factory.createIdentifier(name),
      ts.factory.createModuleBlock(innerStatements),
      ts.NodeFlags.Namespace,
    );
  };

  for (const rootName of [...qualifiedRoots.keys()].sort((a, b) =>
    a.localeCompare(b),
  )) {
    const rootNode = qualifiedRoots.get(rootName);
    if (!rootNode) {
      continue;
    }

    statements.push(buildModuleFromNode(rootName, rootNode, true));
  }

  return statements;
}

function buildClassDeclaration(entry: MetaClassEntry): ts.Statement {
  const members = [...(entry.members ?? [])].sort(
    (left, right) =>
      getLine(left) - getLine(right) || left.name.localeCompare(right.name),
  );
  const classMembers: ts.ClassElement[] = [];
  const fieldGroups = groupByName(
    members.filter(
      (member): member is MetaFieldEntry => member.type === "field",
    ),
  );
  const fnGroups = groupByName(
    members.filter((member): member is MetaFnEntry => member.type === "fn"),
  );

  for (const member of members) {
    if (member.type !== "field") {
      continue;
    }

    const potentialField = member as MetaFieldEntry;
    if (
      typeof potentialField.typ === "string" &&
      potentialField.typ.startsWith(`${entry.name}.`)
    ) {
      continue;
    }

    const fieldGroup = fieldGroups.get(member.name);
    if (!fieldGroup || fieldGroup[0] !== member) {
      continue;
    }

    const fnGroup = fnGroups.get(member.name);
    if (fnGroup && fnGroup.length > 0) {
      classMembers.push(buildCallablePropertyDeclaration(member, fnGroup));
      continue;
    }

    classMembers.push(buildPropertyDeclaration(member));
  }

  for (const [name, group] of fnGroups) {
    if (fieldGroups.has(name)) {
      continue;
    }

    const staticMembers = group.filter((member) => member.is_meth === false);
    const instanceMembers = group.filter((member) => member.is_meth !== false);

    classMembers.push(
      ...instanceMembers.map((member) => buildMethodDeclaration(member, false)),
    );
    classMembers.push(
      ...staticMembers.map((member) => buildMethodDeclaration(member, true)),
    );
  }

  const heritageClauses = buildHeritageClauses(entry.bases ?? []);
  const typeParameters = buildTypeParameters(entry.generics ?? []);

  const hasConstructor = classMembers.some((m) =>
    ts.isConstructorDeclaration(m),
  );
  if (!hasConstructor) {
    const privateCtor = ts.factory.createConstructorDeclaration(
      [ts.factory.createModifier(ts.SyntaxKind.PrivateKeyword)],
      [],
      undefined,
    );
    classMembers.unshift(privateCtor);
  }

  const isQualified = entry.name.includes(".");
  return ts.factory.createClassDeclaration(
    isQualified
      ? [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)]
      : [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    toValidTypeName(getLeafName(entry.name)),
    typeParameters,
    heritageClauses,
    classMembers,
  );
}

function buildEnumDeclaration(entry: MetaEnumEntry): ts.Statement {
  const baseType = getEnumBaseType(entry)?.trim().toLowerCase();
  const fields = getEnumFields(entry);

  const enumMembers = fields.map((field, index) => {
    const initializer = createEnumMemberInitializer(field, index, baseType);
    return ts.factory.createEnumMember(toPropertyName(field.name), initializer);
  });

  const isQualified = entry.name.includes(".");
  return ts.factory.createEnumDeclaration(
    isQualified
      ? [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)]
      : [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    toValidTypeName(getLeafName(entry.name)),
    enumMembers,
  );
}

function buildHeritageClauses(bases: string[]): ts.HeritageClause[] | undefined {
  if (bases.length === 0) {
    return undefined;
  }

  return [
    ts.factory.createHeritageClause(
      ts.SyntaxKind.ExtendsKeyword,
      bases.slice(0, 1).map((baseName) =>
        ts.factory.createExpressionWithTypeArguments(
          ts.factory.createIdentifier(baseName),
          undefined,
        ),
      ),
    ),
  ];
}

function buildTypeParameters(
  entries: Array<string | MetaGenericEntry>,
): ts.TypeParameterDeclaration[] | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return entries.map((entry) => buildTypeParameterDeclaration(entry));
}

function buildTypeParameterDeclaration(
  entry: string | MetaGenericEntry,
): ts.TypeParameterDeclaration {
  const name = typeof entry === "string" ? entry : (entry.name ?? "T");
  const constraint =
    typeof entry === "string" || !entry.base
      ? undefined
      : createTypeNodeFromText(entry.base);

  return ts.factory.createTypeParameterDeclaration(
    undefined,
    ts.factory.createIdentifier(name),
    constraint,
    undefined,
  );
}

function buildMethodDeclaration(
  entry: MetaFnEntry,
  isStatic: boolean,
): ts.MethodDeclaration {
  const signature = buildFunctionSignature(
    entry,
    shouldEmitThisVoidParameter(entry),
  );
  const typeParameters =
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined;

  return ts.factory.createMethodDeclaration(
    isStatic ? [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined,
    undefined,
    toPropertyName(entry.name),
    undefined,
    typeParameters,
    signature.parameters,
    signature.returnType,
    undefined,
  );
}

function buildPropertyDeclaration(entry: MetaFieldEntry): ts.ClassElement {
  const typeNode = entry.typ
    ? createTypeNodeFromText(entry.typ)
    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);

  if (/^\[(string|number)\]$/.test(entry.name)) {
    const indexType =
      entry.name === "[number]"
        ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword)
        : ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    const parameter = ts.factory.createParameterDeclaration(
      undefined,
      undefined,
      "key",
      undefined,
      indexType,
      undefined,
    );

    return ts.factory.createIndexSignature(undefined, [parameter], typeNode);
  }

  return ts.factory.createPropertyDeclaration(
    undefined,
    toPropertyName(entry.name),
    undefined,
    typeNode,
    undefined,
  );
}

function buildCallablePropertyDeclaration(
  fieldEntry: MetaFieldEntry,
  fnEntries: MetaFnEntry[],
): ts.ClassElement {
  const fieldType = fieldEntry.typ
    ? buildFieldTypeNode(fieldEntry.typ, [])
    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
  const callableTypes = fnEntries.map((entry) =>
    buildFunctionTypeNode(entry, shouldEmitThisVoidParameter(entry)),
  );
  const typeNode = ts.factory.createIntersectionTypeNode([
    fieldType,
    ...callableTypes,
  ]);
  const isStatic = fnEntries.some((entry) => entry.is_meth === false);
  const modifiers = isStatic
    ? [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)]
    : undefined;

  return ts.factory.createPropertyDeclaration(
    modifiers,
    toPropertyName(fieldEntry.name),
    undefined,
    typeNode,
    undefined,
  );
}

function buildFunctionDeclaration(entry: MetaFnEntry): ts.FunctionDeclaration {
  const signature = buildFunctionSignature(
    entry,
    shouldEmitThisVoidParameter(entry),
  );

  return ts.factory.createFunctionDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    undefined,
    toValidTopLevelName(entry.name),
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined,
    signature.parameters,
    signature.returnType,
    undefined,
  );
}

function buildFunctionDeclarationFromField(
  entry: MetaFieldEntry,
  warnings: string[],
): ts.FunctionDeclaration {
  if (!entry.typ || !isFunctionType(entry.typ)) {
    throw new Error(`Expected function type for ${entry.name}`);
  }

  const signature = buildFunctionSignatureFromTypeText(entry.typ, warnings, true);

  return ts.factory.createFunctionDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    undefined,
    toValidTopLevelName(entry.name),
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined,
    signature.parameters,
    signature.returnType,
    undefined,
  );
}

function buildFunctionTypeNode(
  entry: MetaFnEntry,
  includeThisVoidParameter: boolean,
): ts.FunctionTypeNode {
  const signature = buildFunctionSignature(entry, includeThisVoidParameter);

  return ts.factory.createFunctionTypeNode(
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined,
    signature.parameters,
    signature.returnType,
  );
}

function buildConstDeclaration(
  name: string,
  entry: MetaFieldEntry,
  warnings: string[],
  customName?: string,
): ts.VariableStatement {
  const typeNode = entry.typ
    ? buildFieldTypeNode(entry.typ, warnings)
    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);

  return withCustomNameComment(
    ts.factory.createVariableStatement(
      [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            ts.factory.createIdentifier(name),
            undefined,
            typeNode,
            undefined,
          ),
        ],
        ts.NodeFlags.Const,
      ),
    ),
    customName,
  );
}

function createCustomNamedVariableStatement(
  name: string,
  typeNode: ts.TypeNode,
  customName: string,
): ts.VariableStatement {
  return withCustomNameComment(
    ts.factory.createVariableStatement(
      [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            ts.factory.createIdentifier(name),
            undefined,
            typeNode,
            undefined,
          ),
        ],
        ts.NodeFlags.Const,
      ),
    ),
    customName,
  );
}

function getEnumBaseType(entry: MetaEnumEntry): string | undefined {
  const baseType = entry.baseType ?? entry.base ?? entry.superType ?? entry.typ;
  return typeof baseType === "string" ? baseType : undefined;
}

function getEnumFields(entry: MetaEnumEntry): MetaEnumFieldEntry[] {
  const fields = entry.fields ?? entry.members ?? [];
  return fields.filter(
    (field): field is MetaEnumFieldEntry =>
      typeof field === "object" &&
      field !== null &&
      typeof field.name === "string",
  );
}

function createEnumMemberInitializer(
  field: MetaEnumFieldEntry,
  index: number,
  baseType?: string,
): ts.Expression | undefined {
  const rawValue = field.value ?? field.literal ?? field.constant ?? field.val;

  if (typeof rawValue === "string") {
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rawValue)) {
      return createNumericExpression(rawValue);
    }

    return ts.factory.createStringLiteral(rawValue);
  }

  if (typeof rawValue === "number") {
    return createNumericExpression(rawValue);
  }

  if (typeof rawValue === "boolean") {
    return rawValue ? ts.factory.createTrue() : ts.factory.createFalse();
  }

  if (baseType === "string") {
    return ts.factory.createStringLiteral(field.name);
  }

  if (baseType === "number" || baseType === "integer") {
    return ts.factory.createNumericLiteral(index);
  }

  return undefined;
}

function createNumericExpression(value: number | string): ts.Expression {
  const text = String(value).trim();
  if (text.startsWith("-")) {
    return ts.factory.createPrefixUnaryExpression(
      ts.SyntaxKind.MinusToken,
      ts.factory.createNumericLiteral(text.slice(1)),
    );
  }

  return ts.factory.createNumericLiteral(text);
}

function getLine(entry: { loc?: MetaLoc | MetaLoc[] | null }): number {
  if (Array.isArray(entry.loc)) {
    return entry.loc[0]?.line ?? Number.POSITIVE_INFINITY;
  }

  return entry.loc?.line ?? Number.POSITIVE_INFINITY;
}

function groupByName<T extends { name: string }>(entries: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const entry of entries) {
    const group = groups.get(entry.name);
    if (group) {
      group.push(entry);
      continue;
    }

    groups.set(entry.name, [entry]);
  }

  return groups;
}
