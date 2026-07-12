import ts from "typescript";

import { RESERVED_TOP_LEVEL_NAMES } from "./constants.js";

export function toValidTypeName(name: string): string {
  return isValidTopLevelName(name) ? name : mangleTopLevelName(name);
}

export function toPropertyName(name: string): ts.PropertyName {
  if (/^\d+$/.test(name)) {
    return ts.factory.createNumericLiteral(name);
  }

  if (/^\[\d+\]$/.test(name)) {
    return ts.factory.createNumericLiteral(name.slice(1, -1));
  }

  return isValidPropertyName(name)
    ? ts.factory.createIdentifier(name)
    : ts.factory.createStringLiteral(name);
}

export function toValidTopLevelName(name: string): string {
  return isValidTopLevelName(name) ? name : mangleTopLevelName(name);
}

export function toValidParameterName(name: string): string {
  return isValidPropertyName(name)
    ? name
    : `_${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function shouldEmitThisVoidParameter(entry: { is_meth?: boolean }): boolean {
  return entry.is_meth !== true;
}

export function isValidPropertyName(name: string): boolean {
  return (
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) &&
    !RESERVED_TOP_LEVEL_NAMES.has(name)
  );
}

export function isValidTopLevelName(name: string): boolean {
  return isValidPropertyName(name);
}

export function mangleTopLevelName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized.length > 0 ? `${sanitized}_` : "generated_";
}

export function withCustomNameComment<T extends ts.Node>(
  node: T,
  customName: string | undefined,
): T {
  if (!customName || !isCustomNameSafe(customName)) {
    return node;
  }

  return ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.MultiLineCommentTrivia,
    `* @customName ${customName} `,
    true,
  );
}

function isCustomNameSafe(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

export function getLeafName(name: string): string {
  const parts = name.split(".").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? name) : name;
}
