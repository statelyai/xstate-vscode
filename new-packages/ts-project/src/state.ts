import type {
  Expression,
  ObjectLiteralExpression,
  PropertyAssignment,
} from 'typescript';
import {
  ActionBlock,
  ActorBlock,
  Edge,
  EventTypeData,
  ExtractionContext,
  Node,
  TreeNode,
} from './types';
import {
  everyDefined,
  findProperty,
  getJsonObject,
  getJsonValue,
  getPropertyKey,
  isUndefined,
  mapMaybeArrayElements,
  uniqueId,
} from './utils';

const createActionBlock = ({
  sourceId,
  parentId,
}: {
  sourceId: string;
  parentId: string;
}): ActionBlock => {
  const blockId = uniqueId();
  return {
    blockType: 'action',
    uniqueId: blockId,
    parentId,
    sourceId,
    properties: {
      type: sourceId,
      params: {},
    },
  };
};
export function createActorBlock({
  sourceId,
  parentId,
  actorId,
}: {
  sourceId: string;
  parentId: string;
  actorId: string;
}): ActorBlock {
  const blockId = uniqueId();
  return {
    blockType: 'actor',
    uniqueId: blockId,
    parentId,
    sourceId,
    properties: {
      src: sourceId,
      id: actorId,
    },
  };
}

function createEdge({
  sourceId,
  eventTypeData,
}: {
  sourceId: string;
  eventTypeData: Edge['data']['eventTypeData'];
}): Edge {
  return {
    type: 'edge',
    uniqueId: uniqueId(),
    source: sourceId,
    targets: [],
    data: {
      eventTypeData,
      actions: [],
      guard: undefined,
      description: undefined,
      // TODO: to compute this correctly we need to know if we are extracting v4 or v5
      internal: true,
    },
  };
}

function isForbiddenTarget(
  ts: typeof import('typescript'),
  element: Expression,
): boolean {
  return (
    isUndefined(ts, element) ||
    // null isn't technically allowed by the XState's types but it behaves in the same way at runtime
    // and it's an easy thing to handle here
    element.kind === ts.SyntaxKind.NullKeyword
  );
}

function getObjectTransitionTargets(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  transition: ObjectLiteralExpression,
) {
  const targetProperty = findProperty(ctx, ts, transition, 'target');

  if (!targetProperty) {
    // TODO: if we failed to find this it doesn't exactly mean that it is a targetless transition
    // for the time being we assume that it is a targetless transition and return undefined as a valid value from here
    return;
  }

  if (isForbiddenTarget(ts, targetProperty.initializer)) {
    return;
  }

  // if we fail extracting the target here then we treat it as an error further down the road
  return mapMaybeArrayElements(ts, targetProperty.initializer, (expression) => {
    return ts.isStringLiteralLike(expression) ? expression.text : undefined;
  });
}

function extractActionBlocks(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  expression: Expression,
  { parentId }: { parentId: string },
) {
  return mapMaybeArrayElements(
    ts,
    expression,
    (element): ActionBlock | undefined => {
      if (isUndefined(ts, element)) {
        return;
      }
      if (ts.isStringLiteralLike(element)) {
        return createActionBlock({
          sourceId: element.text,
          parentId,
        });
      }
      if (ts.isObjectLiteralExpression(element)) {
        const typeProperty = findProperty(ctx, ts, element, 'type');

        if (!typeProperty) {
          return;
        }

        if (ts.isStringLiteralLike(typeProperty.initializer)) {
          return createActionBlock({
            sourceId: typeProperty.initializer.text,
            parentId,
          });
        }
        ctx.errors.push({
          type: 'action_unhandled',
        });
        // fallthrough to creating inline action
      }

      return createActionBlock({
        sourceId: `inline:${uniqueId()}`,
        parentId,
      });
    },
  );
}

function registerActionBlocks(
  ctx: ExtractionContext,
  blocks: ActionBlock[],
  parentContainer: string[],
) {
  for (const block of blocks) {
    parentContainer.push(block.uniqueId);
    ctx.digraph.blocks[block.uniqueId] = block;
    ctx.digraph.implementations.actions[block.sourceId] ??= {
      type: 'action',
      id: block.sourceId,
      name: block.sourceId,
    };
  }
}

function extractEdgeGroup(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  transition: PropertyAssignment,
  {
    sourceId,
    eventTypeData,
  }: {
    sourceId: string;
    eventTypeData: EventTypeData;
  },
) {
  const mapped = mapMaybeArrayElements(
    ts,
    transition.initializer,
    (element): [Edge, string[] | undefined] | undefined => {
      if (isForbiddenTarget(ts, element)) {
        return [
          createEdge({
            sourceId,
            eventTypeData,
          }),
          undefined,
        ];
      }
      if (ts.isStringLiteralLike(element)) {
        return [
          createEdge({
            sourceId,
            eventTypeData,
          }),
          [element.text],
        ];
      }
      if (ts.isObjectLiteralExpression(element)) {
        const targets = getObjectTransitionTargets(ctx, ts, element);

        if (targets && !everyDefined(targets)) {
          ctx.errors.push({ type: 'transition_property_unhandled' });
          return;
        }

        const edge = createEdge({
          sourceId,
          eventTypeData,
        });

        const seen = new Set<string>();

        for (let i = element.properties.length - 1; i >= 0; i--) {
          const prop = element.properties[i];
          if (!ts.isPropertyAssignment(prop)) {
            ctx.errors.push({ type: 'transition_property_unhandled' });
            continue;
          }
          const key = getPropertyKey(ctx, ts, prop);

          if (!key) {
            ctx.errors.push({ type: 'transition_property_unhandled' });
            continue;
          }
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);

          switch (key) {
            case 'actions': {
              const blocks = extractActionBlocks(ctx, ts, prop.initializer, {
                parentId: edge.uniqueId,
              });

              if (!everyDefined(blocks)) {
                ctx.errors.push({
                  type: 'transition_property_unhandled',
                });
                continue;
              }

              registerActionBlocks(ctx, blocks, edge.data.actions);
              break;
            }
            case 'description': {
              edge.data.description = ts.isStringLiteralLike(prop.initializer)
                ? prop.initializer.text
                : undefined;
              break;
            }
          }
        }

        return [edge, targets];
      }
    },
  );

  if (!everyDefined(mapped)) {
    ctx.errors.push({ type: 'transition_property_unhandled' });
    return;
  }

  for (const [edge, targets] of mapped) {
    ctx.digraph.edges[edge.uniqueId] = edge;
    if (targets) {
      ctx.originalTargets[edge.uniqueId] = targets;
    }
  }
}

export function extractState(
  ctx: ExtractionContext,
  ts: typeof import('typescript'),
  state: Expression | undefined,
  parentId: string | undefined,
): TreeNode | undefined {
  const node: Node = {
    type: 'node',
    uniqueId: uniqueId(),
    parentId,
    data: {
      initial: undefined,
      type: 'normal',
      history: undefined,
      metaEntries: [],
      entry: [],
      exit: [],
      invoke: [],
      tags: [],
      description: undefined,
    },
  };

  ctx.digraph.nodes[node.uniqueId] = node;

  const treeNode: TreeNode = {
    uniqueId: node.uniqueId,
    parentId,
    children: {},
  };

  ctx.treeNodes[node.uniqueId] = treeNode;

  if (!state) {
    return treeNode;
  }

  if (!ts.isObjectLiteralExpression(state)) {
    ctx.errors.push({
      type: 'state_unhandled',
    });
    // TODO: rethink if the state should be returned here
    // this is a severe error that impacts a lot
    return treeNode;
  }

  const seen = new Set<string>();

  for (let i = state.properties.length - 1; i >= 0; i--) {
    const prop = state.properties[i];
    if (ts.isPropertyAssignment(prop)) {
      const key = getPropertyKey(ctx, ts, prop);

      if (!key) {
        ctx.errors.push({ type: 'state_property_unhandled' });
        continue;
      }

      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      switch (key) {
        case 'id': {
          if (ts.isStringLiteralLike(prop.initializer)) {
            ctx.idMap[prop.initializer.text] = node.uniqueId;
            continue;
          }
          break;
        }
        case 'context': {
          if (parentId !== undefined) {
            ctx.errors.push({
              type: 'state_property_invalid',
            });
            continue;
          }
          if (ts.isObjectLiteralExpression(prop.initializer)) {
            const obj = getJsonObject(ctx, ts, prop.initializer);
            if (obj) {
              ctx.digraph.data.context = obj;
            }
            continue;
          }
          if (
            ts.isFunctionExpression(prop.initializer) ||
            ts.isArrowFunction(prop.initializer)
          ) {
            ctx.digraph.data.context = `{{${prop.initializer.getText(
              ctx.sourceFile,
            )}}}`;
            continue;
          }

          ctx.errors.push({ type: 'state_property_unhandled' });
          break;
        }
        case 'always': {
          if (!ts.isPropertyAssignment(prop)) {
            ctx.errors.push({ type: 'state_property_unhandled' });
          }
          extractEdgeGroup(ctx, ts, prop, {
            sourceId: node.uniqueId,
            eventTypeData: { type: 'always' },
          });
          break;
        }
        case 'on': {
          if (!ts.isObjectLiteralExpression(prop.initializer)) {
            ctx.errors.push({ type: 'state_property_unhandled' });
            continue;
          }
          for (const transition of prop.initializer.properties) {
            if (!ts.isPropertyAssignment(transition)) {
              ctx.errors.push({ type: 'transition_property_unhandled' });
              return;
            }
            const event = getPropertyKey(ctx, ts, transition);
            if (!event) {
              ctx.errors.push({ type: 'transition_property_unhandled' });
              return;
            }
            extractEdgeGroup(ctx, ts, transition, {
              sourceId: node.uniqueId,
              eventTypeData:
                event === '*'
                  ? { type: 'wildcard' }
                  : {
                      type: 'named',
                      eventType: event,
                    },
            });
          }
          break;
        }
        case 'states':
          if (!ts.isObjectLiteralExpression(prop.initializer)) {
            ctx.errors.push({
              type: 'state_unhandled',
            });
            break;
          }
          for (const state of prop.initializer.properties) {
            if (ts.isPropertyAssignment(state)) {
              const childKey = getPropertyKey(ctx, ts, state);
              if (childKey) {
                const childTreeNode = extractState(
                  ctx,
                  ts,
                  state.initializer,
                  node.uniqueId,
                );
                if (!childTreeNode) {
                  continue;
                }
                treeNode.children[childKey] = childTreeNode;
              }
              continue;
            }
            ctx.errors.push({
              type: 'state_property_unhandled',
            });
            continue;
          }
          break;
        case 'initial': {
          if (ts.isStringLiteralLike(prop.initializer)) {
            node.data.initial = prop.initializer.text;
            continue;
          }
          if (isUndefined(ts, prop.initializer)) {
            continue;
          }
          ctx.errors.push({
            type: 'state_property_unhandled',
          });
          break;
        }
        case 'type': {
          if (ts.isStringLiteralLike(prop.initializer)) {
            const text = prop.initializer.text;
            if (text === 'history' || text === 'parallel' || text === 'final') {
              node.data.type = text;
              continue;
            }
            if (text === 'atomic' || text === 'compound') {
              // type already starts as 'normal' so it doesn't have to be chamged here
              continue;
            }
            ctx.errors.push({
              type: 'state_type_invalid',
            });
            continue;
          }
          if (isUndefined(ts, prop.initializer)) {
            continue;
          }
          ctx.errors.push({
            type: 'state_property_unhandled',
          });
          break;
        }
        // TODO: this property only has effect if type is set to history
        case 'history': {
          if (ts.isStringLiteralLike(prop.initializer)) {
            const text = prop.initializer.text;
            if (text === 'shallow' || text === 'deep') {
              node.data.history = text;
              continue;
            }
            ctx.errors.push({
              type: 'state_history_invalid',
            });
          }
          if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
            node.data.history = 'deep';
            continue;
          }
          if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) {
            node.data.history = 'shallow';
            continue;
          }
          if (isUndefined(ts, prop.initializer)) {
            continue;
          }
          ctx.errors.push({
            type: 'state_property_unhandled',
          });
          break;
        }
        case 'description': {
          if (ts.isStringLiteralLike(prop.initializer)) {
            node.data.description = prop.initializer.text;
            continue;
          }
          if (isUndefined(ts, prop.initializer)) {
            continue;
          }
          ctx.errors.push({
            type: 'state_property_unhandled',
          });
          break;
        }
        case 'meta': {
          if (ts.isObjectLiteralExpression(prop.initializer)) {
            for (const meta of prop.initializer.properties) {
              if (ts.isPropertyAssignment(meta)) {
                const metaKey = getPropertyKey(ctx, ts, meta);
                if (metaKey) {
                  node.data.metaEntries.push([
                    metaKey,
                    getJsonValue(ctx, ts, meta.initializer),
                  ]);
                }
                continue;
              }
            }
            continue;
          }
          if (isUndefined(ts, prop.initializer)) {
            continue;
          }

          ctx.errors.push({
            type: 'state_property_unhandled',
          });
          break;
        }
        case 'entry':
        case 'exit': {
          const blocks = extractActionBlocks(ctx, ts, prop.initializer, {
            parentId: node.uniqueId,
          });

          if (!everyDefined(blocks)) {
            ctx.errors.push({
              type: 'state_property_unhandled',
            });
            continue;
          }

          registerActionBlocks(ctx, blocks, node.data[key]);
          break;
        }
        case 'invoke': {
          const blocks = mapMaybeArrayElements(
            ts,
            prop.initializer,
            (element, index): ActorBlock | undefined => {
              if (isUndefined(ts, element)) {
                return;
              }
              if (ts.isObjectLiteralExpression(element)) {
                const srcProperty = findProperty(ctx, ts, element, 'src');

                if (!srcProperty) {
                  return;
                }

                const idProperty = findProperty(ctx, ts, element, 'id');

                return createActorBlock({
                  sourceId: ts.isStringLiteralLike(srcProperty.initializer)
                    ? srcProperty.initializer.text
                    : `inline:${uniqueId()}`,
                  parentId: node.uniqueId,
                  actorId:
                    idProperty && ts.isStringLiteralLike(idProperty.initializer)
                      ? idProperty.initializer.text
                      : `inline:${uniqueId()}`,
                });
              }

              return createActorBlock({
                sourceId: `inline:${uniqueId()}`,
                parentId: node.uniqueId,
                actorId: `inline:${uniqueId()}}`,
              });
            },
          );

          if (!everyDefined(blocks)) {
            ctx.errors.push({
              type: 'state_property_unhandled',
            });
            continue;
          }

          for (const block of blocks) {
            node.data[key].push(block.uniqueId);
            ctx.digraph.blocks[block.uniqueId] = block;
            ctx.digraph.implementations.actors[block.sourceId] ??= {
              type: 'actor',
              id: block.sourceId,
              name: block.sourceId,
            };
          }
          break;
        }
      }
      continue;
    }

    if (ts.isShorthandPropertyAssignment(prop)) {
      ctx.errors.push({
        type: 'state_property_unhandled',
      });
      continue;
    }
    if (ts.isSpreadAssignment(prop)) {
      ctx.errors.push({
        type: 'state_property_unhandled',
      });
      continue;
    }
    if (
      ts.isMethodDeclaration(prop) ||
      ts.isGetAccessorDeclaration(prop) ||
      ts.isSetAccessorDeclaration(prop)
    ) {
      ctx.errors.push({
        type: 'state_property_unhandled',
      });
      continue;
    }

    prop satisfies never;
  }

  return treeNode;
}
