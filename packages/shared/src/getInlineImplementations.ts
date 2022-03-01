import type { MachineParseResult } from "@xstate/machine-extractor";
import { getRawTextFromNode, ImplementationsMetadata } from ".";

export const getInlineImplementations = (
  parseResult: MachineParseResult | undefined,
  fileText: string,
): ImplementationsMetadata => {
  const allGuards =
    parseResult?.getAllConds(["inline", "identifier", "unknown"]) || [];

  const allServices =
    parseResult?.getAllServices(["inline", "identifier", "unknown"]) || [];

  const allActions =
    parseResult?.getAllActions(["inline", "identifier", "unknown"]) || [];

  const inlineImplementations: ImplementationsMetadata = {
    actions: {},
    guards: {},
    services: {},
  };

  allGuards.forEach((guard) => {
    inlineImplementations.guards[guard.inlineDeclarationId] = {
      jsImplementation: getRawTextFromNode(fileText, guard.node),
    };
  });
  allActions.forEach((action) => {
    inlineImplementations.actions[action.inlineDeclarationId] = {
      jsImplementation: getRawTextFromNode(fileText, action.node),
    };
  });
  allServices.forEach((service) => {
    if (service.srcNode) {
      inlineImplementations.services[service.inlineDeclarationId] = {
        jsImplementation: getRawTextFromNode(fileText, service.srcNode),
      };
    }
  });

  return inlineImplementations;
};
