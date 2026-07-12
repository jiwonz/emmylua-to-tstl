import ts from "typescript";

import {
  BARE_UNRESOLVED_TYPE_RE,
  KNOWN_BUILTIN_TYPE_NAMES,
  LUA_FUNCTION_RE,
  QUALIFIED_UNRESOLVED_TYPE_RE,
} from "./constants.js";
import { toValidParameterName } from "./name-utils.js";
import type {
  FunctionSignatureSpec,
  MetaFieldEntry,
  MetaFnEntry,
  MetaFnParam,
  MetaFnReturn,
  MetaGenericEntry,
  TypeResolutionContext,
  UnresolvedTypeMode,
} from "./types.js";

let activeTypeResolutionContext: TypeResolutionContext | undefined;

export function setActiveTypeResolutionContext(
  context: TypeResolutionContext | undefined,
): void {
  activeTypeResolutionContext = context;
}

export function createTypeResolutionContext(options: {
  mode: UnresolvedTypeMode;
  knownTypeNames: Set<string>;
  warnings: string[];
}): TypeResolutionContext {
  return {
    mode: options.mode,
    knownTypeNames: options.knownTypeNames,
    unresolvedTypeNames: new Set<string>(),
    unresolvedAliasNames: new Set<string>(),
    warnedUnresolvedNames: new Set<string>(),
    warnings: options.warnings,
  };
}

export function buildFunctionSignature(
  entry: MetaFnEntry,
  includeThisVoidParameter: boolean,
): FunctionSignatureSpec {
  const typeParameters = buildFunctionTypeParameters(entry.generics ?? []);
  const parameters = [
    ...(includeThisVoidParameter ? [createThisVoidParameter()] : []),
    ...(entry.params ?? []).map((param) => buildParameterDeclaration(param)),
  ];
  const returnType = buildReturnType(entry.returns ?? []);

  return { typeParameters, parameters, returnType };
}

export function buildFunctionSignatureFromTypeText(
  typeText: string,
  warnings: string[],
  includeThisVoidParameter: boolean,
): FunctionSignatureSpec {
  return parseFunctionTypeText(typeText, warnings, includeThisVoidParameter);
}

export function createFunctionTypeNodeFromFieldEntry(
  entry: MetaFieldEntry,
  warnings: string[],
): ts.TypeNode {
  if (!entry.typ || !isFunctionType(entry.typ)) {
    throw new Error(`Expected function type for ${entry.name}`);
  }

  const signature = buildFunctionSignatureFromTypeText(entry.typ, warnings, true);

  return ts.factory.createFunctionTypeNode(
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined,
    signature.parameters,
    signature.returnType,
  );
}

export function normalizeLuaTypeText(typeText: string, warnings: string[]): string {
  const trimmed = typeText.trim();

  if (trimmed.startsWith("fun")) {
    return normalizeFunctionTypeText(trimmed, warnings);
  }

  let normalized = trimmed;
  normalized = normalized.replace(/\binteger\b/g, "number");
  normalized = normalized.replace(/\bnil\b/g, "undefined");
  normalized = normalized.replace(/\bvoid\b/g, "void");
  normalized = normalized.replace(/\bany\b/g, "any");
  normalized = normalized.replace(/\btable<([^>]+)>/g, (_, inner: string) => {
    const parts = splitTopLevel(inner, ",");
    if (parts.length === 1) {
      const [valueText] = parts;
      return `Record<string, ${valueText?.trim() ?? "any"}>`;
    }

    const [keyText, valueText] = parts;
    return `Record<${keyText?.trim() ?? "string"}, ${valueText?.trim() ?? "any"}>`;
  });
  normalized = normalized.replace(
    /([^\w])([A-Za-z_][A-Za-z0-9_]*\?)\b/g,
    (_match, prefix: string, typeName: string) =>
      `${prefix}${typeName.replace(/\?$/, "")} | undefined`,
  );

  return normalized;
}

export function normalizeFunctionTypeText(
  typeText: string,
  warnings: string[],
): string {
  const match = LUA_FUNCTION_RE.exec(typeText.trim());

  if (!match?.groups) {
    return typeText;
  }

  const genericText = match.groups.generics?.trim() ?? "";
  const paramsText = match.groups.params?.trim() ?? "";
  const returnsText = match.groups.returns?.trim() ?? "";
  const genericPrefix = genericText.length > 0 ? `<${genericText}>` : "";
  const parameterText =
    paramsText.length > 0
      ? splitTopLevel(paramsText, ",")
          .map((paramText) =>
            normalizeFunctionParameterText(paramText.trim(), warnings),
          )
          .join(", ")
      : "";
  const returnText =
    returnsText.length > 0
      ? normalizeLuaTypeText(returnsText, warnings)
      : "void";

  return `${genericPrefix}(${parameterText}) => ${returnText}`;
}

export function createTypeNodeFromText(typeText: string): ts.TypeNode {
  const normalized = normalizeLuaTypeText(typeText, []);
  const finalized = collectUnresolvedTypeNames(normalized);
  const sourceFile = ts.createSourceFile(
    "generated-type.ts",
    `type __T = ${finalized};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];

  if (!statement || !ts.isTypeAliasDeclaration(statement)) {
    throw new Error(`Unable to parse type node: ${typeText}`);
  }

  return statement.type;
}

export function isFunctionType(typeText: string | undefined): boolean {
  return typeText?.trim().startsWith("fun") ?? false;
}

export function buildFieldTypeNode(typeText: string, warnings: string[]): ts.TypeNode {
  if (isFunctionType(typeText)) {
    return createTypeNodeFromText(normalizeFunctionTypeText(typeText, warnings));
  }

  return createTypeNodeFromText(typeText);
}

function buildFunctionTypeParameters(
  entries: Array<string | MetaGenericEntry>,
): ts.TypeParameterDeclaration[] {
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

function buildParameterDeclaration(param: MetaFnParam): ts.ParameterDeclaration {
  const cleanedName = param.name.replace(/\?$/, "");
  const isRest = cleanedName.startsWith("...");
  const identifier = isRest ? cleanedName.slice(3) || "args" : cleanedName;
  const typeNode = param.typ
    ? createTypeNodeFromText(param.typ)
    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
  const finalTypeNode = isRest ? ts.factory.createArrayTypeNode(typeNode) : typeNode;

  return ts.factory.createParameterDeclaration(
    undefined,
    isRest ? ts.factory.createToken(ts.SyntaxKind.DotDotDotToken) : undefined,
    toValidParameterName(identifier),
    param.name.endsWith("?")
      ? ts.factory.createToken(ts.SyntaxKind.QuestionToken)
      : undefined,
    finalTypeNode,
    undefined,
  );
}

function createThisVoidParameter(): ts.ParameterDeclaration {
  return ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    ts.factory.createIdentifier("this"),
    undefined,
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
    undefined,
  );
}

function buildReturnType(returns: MetaFnReturn[]): ts.TypeNode {
  if (returns.length === 0) {
    return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  }

  if (returns.length === 1) {
    const first = returns[0];
    return first?.typ
      ? createTypeNodeFromText(first.typ)
      : ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  }

  return ts.factory.createTypeReferenceNode("LuaMultiReturn", [
    ts.factory.createTupleTypeNode(
      returns.map((item) =>
        item.typ
          ? createTypeNodeFromText(item.typ)
          : ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
      ),
    ),
  ]);
}

function parseFunctionTypeText(
  typeText: string,
  warnings: string[],
  includeThisVoidParameter: boolean,
): FunctionSignatureSpec {
  const match = LUA_FUNCTION_RE.exec(typeText.trim());

  if (!match?.groups) {
    throw new Error(`Cannot parse function type: ${typeText}`);
  }

  const genericText = match.groups.generics?.trim() ?? "";
  const paramsText = match.groups.params?.trim() ?? "";
  const returnsText = match.groups.returns?.trim() ?? "";

  const typeParameters =
    genericText.length > 0
      ? genericText
          .split(",")
          .map((name) => buildTypeParameterDeclaration(name.trim()))
      : [];
  const parameters = [
    ...(includeThisVoidParameter ? [createThisVoidParameter()] : []),
    ...(paramsText.length > 0
      ? splitTopLevel(paramsText, ",").map((paramText) =>
          buildParameterFromFunctionTypeParam(paramText.trim(), warnings),
        )
      : []),
  ];
  const returnType =
    returnsText.length > 0
      ? createTypeNodeFromText(normalizeLuaTypeText(returnsText, warnings))
      : ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);

  return { typeParameters, parameters, returnType };
}

function buildParameterFromFunctionTypeParam(
  paramText: string,
  warnings: string[],
): ts.ParameterDeclaration {
  const cleaned = paramText.replace(/\.{3,}/g, "...").trim();

  if (cleaned.startsWith("...")) {
    const restTypeText = cleaned.includes(":")
      ? cleaned.slice(cleaned.indexOf(":") + 1).trim()
      : "any";
    return ts.factory.createParameterDeclaration(
      undefined,
      ts.factory.createToken(ts.SyntaxKind.DotDotDotToken),
      ts.factory.createIdentifier("args"),
      undefined,
      ts.factory.createArrayTypeNode(
        createTypeNodeFromText(normalizeLuaTypeText(restTypeText, warnings)),
      ),
      undefined,
    );
  }

  const colonIndex = cleaned.indexOf(":");
  if (colonIndex === -1) {
    return ts.factory.createParameterDeclaration(
      undefined,
      undefined,
      ts.factory.createIdentifier(toValidParameterName(cleaned)),
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      undefined,
    );
  }

  const rawName = cleaned.slice(0, colonIndex).trim();
  const rawType = cleaned.slice(colonIndex + 1).trim();
  const isOptional = rawName.endsWith("?");
  const name = rawName.replace(/\?$/, "");

  return ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    ts.factory.createIdentifier(toValidParameterName(name)),
    isOptional ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
    createTypeNodeFromText(normalizeLuaTypeText(rawType, warnings)),
    undefined,
  );
}

function normalizeFunctionParameterText(
  paramText: string,
  warnings: string[],
): string {
  const cleaned = paramText.replace(/\.{3,}/g, "...").trim();

  if (cleaned.startsWith("...")) {
    const restTypeText = cleaned.includes(":")
      ? cleaned.slice(cleaned.indexOf(":") + 1).trim()
      : "any";
    return `...args: ${normalizeLuaTypeText(restTypeText, warnings)}[]`;
  }

  const colonIndex = cleaned.indexOf(":");
  if (colonIndex === -1) {
    return `${toValidParameterName(cleaned)}: any`;
  }

  const rawName = cleaned.slice(0, colonIndex).trim().replace(/\?$/, "");
  const rawType = cleaned.slice(colonIndex + 1).trim();
  const optional = cleaned.slice(0, colonIndex).trim().endsWith("?");

  return `${toValidParameterName(rawName)}${optional ? "?" : ""}: ${normalizeLuaTypeText(rawType, warnings)}`;
}

function collectUnresolvedTypeNames(typeText: string): string {
  const context = activeTypeResolutionContext;
  if (!context) {
    return typeText;
  }

  if (context.mode === "any-all" || context.mode === "unknown") {
    return typeText.replace(
      QUALIFIED_UNRESOLVED_TYPE_RE,
      (match, name: string, offset: number, fullText: string) => {
        if (!isUnresolvedQualifiedType(name, offset, fullText, context)) {
          return match;
        }

        context.unresolvedTypeNames.add(name);
        if (!context.warnedUnresolvedNames.has(name)) {
          context.warnedUnresolvedNames.add(name);
          context.warnings.push(
            `Unresolved type '${name}' encountered; replaced with '${context.mode === "unknown" ? "unknown" : "any"}' due to --unresolved-type ${context.mode}.`,
          );
        }

        return context.mode === "unknown" ? "unknown" : "any";
      },
    );
  }

  return typeText.replace(
    BARE_UNRESOLVED_TYPE_RE,
    (match, name: string, offset: number, fullText: string) => {
      if (!isUnresolvedBareType(name, offset, fullText, context)) {
        return match;
      }

      context.unresolvedTypeNames.add(name);

      if (
        context.mode === "any" ||
        context.mode === "any-bare" ||
        context.mode === "unknown"
      ) {
        if (!context.warnedUnresolvedNames.has(name)) {
          context.warnedUnresolvedNames.add(name);
          context.warnings.push(
            `Unresolved bare type '${name}' encountered; replaced with '${context.mode === "unknown" ? "unknown" : "any"}' due to --unresolved-type ${context.mode}.`,
          );
        }
        return context.mode === "unknown" ? "unknown" : "any";
      }

      if (context.mode === "alias-any") {
        context.unresolvedAliasNames.add(name);
        if (!context.warnedUnresolvedNames.has(name)) {
          context.warnedUnresolvedNames.add(name);
          context.warnings.push(
            `Unresolved bare type '${name}' encountered; preserving name and emitting 'declare type ${name} = any'.`,
          );
        }
        return name;
      }

      return name;
    },
  );
}

function isUnresolvedQualifiedType(
  name: string,
  offset: number,
  fullText: string,
  context: TypeResolutionContext,
): boolean {
  if (name.length <= 1) {
    return false;
  }

  const rootName = name.split(".")[0] ?? name;
  if (
    !rootName ||
    context.knownTypeNames.has(rootName) ||
    KNOWN_BUILTIN_TYPE_NAMES.has(rootName)
  ) {
    return false;
  }

  const prevChar = offset > 0 ? fullText[offset - 1] : "";
  const nextChar =
    offset + name.length < fullText.length
      ? fullText[offset + name.length]
      : "";

  if (prevChar === "." || nextChar === ".") {
    return false;
  }

  return true;
}

function isUnresolvedBareType(
  name: string,
  offset: number,
  fullText: string,
  context: TypeResolutionContext,
): boolean {
  if (name.length <= 1) {
    return false;
  }

  if (context.knownTypeNames.has(name) || KNOWN_BUILTIN_TYPE_NAMES.has(name)) {
    return false;
  }

  const prevChar = offset > 0 ? fullText[offset - 1] : "";
  const nextChar =
    offset + name.length < fullText.length
      ? fullText[offset + name.length]
      : "";

  if (prevChar === "." || nextChar === ".") {
    return false;
  }

  return true;
}

export function splitTopLevel(text: string, separator: string): string[] {
  const result: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let current = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "<") {
      depthAngle += 1;
    } else if (char === ">") {
      depthAngle = Math.max(0, depthAngle - 1);
    } else if (char === "(") {
      depthParen += 1;
    } else if (char === ")") {
      depthParen = Math.max(0, depthParen - 1);
    } else if (char === "[") {
      depthBracket += 1;
    } else if (char === "]") {
      depthBracket = Math.max(0, depthBracket - 1);
    } else if (char === "{") {
      depthBrace += 1;
    } else if (char === "}") {
      depthBrace = Math.max(0, depthBrace - 1);
    }

    if (
      char === separator &&
      depthAngle === 0 &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0
    ) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    result.push(current.trim());
  }

  return result;
}
