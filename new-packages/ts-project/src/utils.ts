import type {
  CallExpression,
  Expression,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  PropertyAssignment,
  SourceFile,
} from 'typescript';
import * as charCodes from './charCodes';
import { safeStringLikeLiteralText } from './safeStringLikeLiteralText';
import { AstPath, ExtractionContext, JsonObject, JsonValue } from './types';

export function assert(condition: unknown): asserts condition {
  if (!condition) {
    throw new Error('Assertion failed');
  }
}

function enterAstPathSegment(ctx: ExtractionContext, segment: AstPath[number]) {
  ctx.currentAstPath.push(segment);
}

function exitAstPathSegment(ctx: ExtractionContext) {
  ctx.currentAstPath.pop();
}

export function withAstPathSegment<T>(
  ctx: ExtractionContext,
  segment: AstPath[number],
  cb: () => T,
): T {
  try {
    enterAstPathSegment(ctx, segment);
    return cb();
  } finally {
    exitAstPathSegment(ctx);
  }
}

export const uniqueId = () => {
  return Math.random().toString(36).substring(2);
};

function getLiteralText(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  node: Expression,
) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    // `.getText()` returns original text whereas `.text` on numeric literals return `(+originalText).toString()`
    // for big ints this loses precision or might even return `'Infinity'`
    const text = node.getText();
    if (text !== node.text) {
      ctx.errors.push({
        type: 'property_key_no_roundtrip',
      });
    }
    return text;
  }
}

export function getPropertyKey(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  prop: PropertyAssignment,
) {
  if (ts.isIdentifier(prop.name)) {
    return ts.idText(prop.name);
  }
  if (ts.isExpression(prop.name)) {
    return getLiteralText(ctx, ts, prop.name);
  }
  if (ts.isComputedPropertyName(prop.name)) {
    const text = getLiteralText(ctx, ts, prop.name.expression);
    if (typeof text === 'string') {
      return text;
    }
    ctx.errors.push({
      type: 'property_key_unhandled',
      propertyKind: 'computed',
    });
    return;
  }
  if (ts.isPrivateIdentifier(prop.name)) {
    ctx.errors.push({
      type: 'property_key_unhandled',
      propertyKind: 'private',
    });
    return;
  }
  prop.name satisfies never;
}

export const isUndefined = (
  ts: typeof import('typescript'),
  prop: Expression,
) => ts.isIdentifier(prop) && ts.idText(prop) === 'undefined';

export function getJsonValue(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  prop: Expression,
): JsonValue | undefined {
  if (ts.isStringLiteralLike(prop)) {
    return prop.text;
  }
  if (ts.isNumericLiteral(prop)) {
    return +prop.text;
  }
  if (prop.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (prop.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (prop.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  // TODO: set a strategy here. Ignore the whole array if an items can't be extracted or try to extract as much as possible?
  if (ts.isArrayLiteralExpression(prop)) {
    const arr = [];
    for (const elem of prop.elements) {
      const value = getJsonValue(ctx, ts, elem);
      if (value === undefined) {
        // TODO: raise error
        return;
      }
      arr.push(value);
    }
    return arr;
  }
  if (ts.isObjectLiteralExpression(prop)) {
    return getJsonObject(ctx, ts, prop);
  }
}

export const getJsonObject = (
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  prop: ObjectLiteralExpression,
) => {
  const obj: JsonObject = {};
  for (const p of prop.properties) {
    if (ts.isPropertyAssignment(p)) {
      const key = getPropertyKey(ctx, ts, p);
      if (key) {
        const value = getJsonValue(ctx, ts, p.initializer);
        if (value === undefined) {
          // TODO: raise error
          return;
        }
        obj[key] = value;
      }
    }
  }
  return obj;
};

export function mapMaybeArrayElements<T>(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  expression: Expression,
  cb: (element: Expression, index: number) => T,
): T[] {
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element, index) => {
      return withAstPathSegment(ctx, index, () => cb(element, index));
    });
  } else {
    return [cb(expression, 0)];
  }
}

export function everyDefined<T>(arr: T[]): arr is NonNullable<T>[] {
  return arr.every((item) => item !== undefined);
}

export function findProperty(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  obj: ObjectLiteralExpression,
  key: string,
): PropertyAssignment | undefined {
  for (let i = obj.properties.length - 1; i >= 0; i--) {
    const prop = obj.properties[i];
    if (
      ts.isPropertyAssignment(prop) &&
      getPropertyKey(ctx, ts, prop) === key
    ) {
      return prop;
    }
  }
}

export function forEachStaticProperty(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  obj: ObjectLiteralExpression,
  cb: (prop: PropertyAssignment, key: string) => void,
) {
  const seen = new Set<string>();
  for (let i = obj.properties.length - 1; i >= 0; i--) {
    const prop = obj.properties[i];

    if (!ts.isPropertyAssignment(prop)) {
      ctx.errors.push({ type: 'property_unhandled' });
      continue;
    }
    const key = getPropertyKey(ctx, ts, prop);

    if (!key) {
      // error should already be reported by `getPropertyKey`
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    withAstPathSegment(ctx, i, () => cb(prop, key));
  }
}

export function findNodeByAstPath(
  ts: typeof import('typescript'),
  call: CallExpression,
  path: AstPath,
): Expression {
  let current: Expression | undefined = call.arguments[0];
  for (const segment of path) {
    if (!current || !ts.isObjectLiteralExpression(current)) {
      throw new Error('Invalid node');
    }
    const retrieved: ObjectLiteralElementLike = current.properties[segment];
    if (!retrieved || !ts.isPropertyAssignment(retrieved)) {
      throw new Error('Invalid node');
    }
    current = retrieved.initializer;
  }
  return current;
}

export function isValidIdentifier(name: string): boolean {
  return /^(?!\d)[\w$]+$/.test(name);
}

export function getPreferredQuoteCharCode(
  ts: typeof import('typescript'),
  sourceFile: SourceFile,
) {
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      // it should always be a string literal but TS allows other things here (for which grammar errors are raised)
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return statement.moduleSpecifier.getText().charCodeAt(0) as
        | typeof charCodes.doubleQuote
        | typeof charCodes.singleQuote;
    }
  }

  return charCodes.doubleQuote;
}

export function safePropertyNameString(
  name: string,
  preferredQuoteCharCode:
    | typeof charCodes.doubleQuote
    | typeof charCodes.singleQuote
    | typeof charCodes.backtick,
) {
  const safeString = safeStringLikeLiteralText(name, preferredQuoteCharCode);
  return safeString.charCodeAt(0) === charCodes.backtick
    ? `[${safeString}]`
    : safeString;
}
