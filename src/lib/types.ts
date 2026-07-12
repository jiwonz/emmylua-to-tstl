import type ts from "typescript";

export interface CliOptions {
  sourcePath: string;
  jsonPath: string | undefined;
  outPath: string | undefined;
  outDir?: string | undefined;
  includePatterns?: string[] | undefined;
  excludePatterns?: string[] | undefined;
  unresolvedTypeMode?: UnresolvedTypeMode;
  noCheck?: boolean;
}

export type UnresolvedTypeMode =
  | "strict"
  | "nonstrict"
  | "any"
  | "unknown"
  | "alias-any"
  | "any-bare"
  | "any-all";

export interface MetaDocument {
  modules?: unknown[];
  types: MetaTypeEntry[];
  globals?: MetaTypeEntry[];
}

export interface MetaLoc {
  file?: string;
  line?: number;
}

export interface MetaBaseEntry {
  type: string;
  name: string;
  description?: string | null;
  loc?: MetaLoc | MetaLoc[] | null;
}

export interface MetaClassEntry extends MetaBaseEntry {
  type: "class";
  bases?: string[];
  generics?: string[];
  members?: MetaMemberEntry[];
}

export interface MetaEnumFieldEntry {
  name: string;
  value?: unknown;
  literal?: unknown;
  [key: string]: unknown;
}

export interface MetaEnumEntry extends MetaBaseEntry {
  type: "enum";
  base?: string;
  baseType?: string;
  superType?: string;
  typ?: string;
  fields?: MetaEnumFieldEntry[];
  members?: MetaEnumFieldEntry[];
}

export interface MetaFieldEntry extends MetaBaseEntry {
  type: "field";
  typ?: string;
  literal?: unknown;
}

export interface MetaFnParam {
  name: string;
  typ?: string;
  desc?: string;
}

export interface MetaFnReturn {
  name?: string | null;
  typ?: string;
  desc?: string;
}

export interface MetaFnEntry extends MetaBaseEntry {
  type: "fn";
  generics?: Array<string | MetaGenericEntry>;
  params?: MetaFnParam[];
  returns?: MetaFnReturn[];
  overloads?: MetaFnEntry[];
  is_meth?: boolean;
  is_async?: boolean;
  is_nodiscard?: boolean;
  nodiscard_message?: string | null;
}

export interface MetaGenericEntry {
  name?: string;
  base?: string | null;
}

export type MetaTypeEntry =
  | MetaClassEntry
  | MetaEnumEntry
  | MetaFieldEntry
  | MetaFnEntry;
export type MetaMemberEntry = MetaFieldEntry | MetaFnEntry;

export interface FunctionSignatureSpec {
  typeParameters: ts.TypeParameterDeclaration[];
  parameters: ts.ParameterDeclaration[];
  returnType: ts.TypeNode;
}

export interface GenerationResult {
  text: string;
  warnings: string[];
}

export interface TypeResolutionContext {
  mode: UnresolvedTypeMode;
  knownTypeNames: Set<string>;
  unresolvedTypeNames: Set<string>;
  unresolvedAliasNames: Set<string>;
  warnedUnresolvedNames: Set<string>;
  warnings: string[];
}

export interface LoadedDocument {
  metaFile: string;
  jsonPath: string;
  document: MetaDocument;
}
