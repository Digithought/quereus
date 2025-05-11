import type { PlanNode } from '../planner/nodes/plan-node.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import type { EmissionContext } from './emission-context.js';
import { SqliterError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('emitter:vdbe-emitter');
const warnLog = log.extend('warn');

/** Type for a callback that emits VDBE for processing one row within a loop. */
export type ProcessRowCallback = (context: EmissionContext, emitter: VdbeEmitter, loopOptions?: VisitOptions) => void;

/**
 * Optional parameters that can be passed during the emission visit to child nodes.
 */
export interface VisitOptions {
  targetRegister?: number;
  processRowCb?: ProcessRowCallback; // Callback for loop-driving nodes to insert row processing logic
  // Potentially other options like requiredCollation, etc.
}

/**
 * Type definition for a function that emits VDBE instructions for a specific PlanNode.
 * @param node The PlanNode to emit instructions for.
 * @param context The EmissionContext to use for generating instructions.
 * @param emitter The VdbeEmitter instance, allowing emitters to recursively call for child nodes.
 * @param options Optional parameters passed from the parent emitter.
 */
export type PlanNodeEmitter = (node: PlanNode, context: EmissionContext, emitter: VdbeEmitter, options?: VisitOptions) => void;

/**
 * Traverses a PlanNode tree and emits VDBE instructions using registered emitters
 * for each node type.
 */
export class VdbeEmitter {
  private emitterRegistry: Map<PlanNodeType, PlanNodeEmitter> = new Map();
  public planNodeToCursorIndex: Map<PlanNode, number> = new Map(); // Map PlanNode to its VDBE cursor index

  constructor(private emissionContext: EmissionContext) {}

  /**
   * Registers an emitter function for a given PlanNodeType.
   * @param nodeType The type of the PlanNode.
   * @param emitter The function to emit VDBE instructions for this node type.
   */
  public registerEmitter(nodeType: PlanNodeType, emitter: PlanNodeEmitter): void {
    if (this.emitterRegistry.has(nodeType)) {
      warnLog(`Emitter for PlanNodeType.${nodeType} is being overwritten.`);
    }
    this.emitterRegistry.set(nodeType, emitter);
  }

  /**
   * Registers multiple emitter functions from a map.
   * @param emitters A map where keys are PlanNodeTypes and values are their corresponding emitters.
   */
  public registerEmitters(emitters: Map<PlanNodeType, PlanNodeEmitter>): void {
    emitters.forEach((emitter, nodeType) => {
      this.registerEmitter(nodeType, emitter);
    });
  }

  /**
   * Emits VDBE instructions for the given PlanNode tree.
   * The main entry point for VDBE code generation.
   * @param rootNode The root of the PlanNode tree.
   * @param options Optional parameters for the root emission call.
   */
  public emit(rootNode: PlanNode, options?: VisitOptions): void {
    this.visit(rootNode, options);
  }

  /**
   * Visits a PlanNode and emits instructions for it and its children.
   * This method is called recursively by emitter functions to process child nodes.
   * @param node The PlanNode to visit.
   * @param options Optional parameters passed from the parent emitter.
   */
  public visit(node: PlanNode, options?: VisitOptions): void {
    const specificEmitter = this.emitterRegistry.get(node.nodeType);

    if (specificEmitter) {
      specificEmitter(node, this.emissionContext, this, options);
    } else {
      warnLog(`No VDBE emitter registered for PlanNodeType ${node.nodeType}. Attempting to visit children.`);
      node.getRelations().forEach(relationNode => {
        this.visit(relationNode, options); // Pass options down
      });
      node.getChildren().forEach(childNode => {
        this.visit(childNode as PlanNode, options); // Pass options down
      });
      // throw new SqliterError(`No VDBE emitter registered for PlanNodeType ${node.nodeType}`, StatusCode.INTERNAL);
    }
  }

  /**
   * A helper to explicitly emit child nodes, typically called by a parent node's emitter.
   * This allows an emitter to control when and how its children are processed.
   * @param node The child PlanNode to emit.
   * @param options Optional parameters for the child emission call.
   */
  public emitChild(node: PlanNode, options?: VisitOptions): void {
    this.visit(node, options);
  }

  /** Clears any emission-specific state, like cursor mappings. */
  public resetState(): void {
    this.planNodeToCursorIndex.clear();
    // Potentially reset other stateful properties if added
  }
}
