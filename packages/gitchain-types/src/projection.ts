/**
 * @0711/gitchain-types — projection-rule type contract
 *
 * Phase F.2 / Task 3 (types layer). The runtime rule registry and rule
 * implementations live elsewhere (the porting of `regelBasierteKuration`
 * from `legacy/elster-mvp/server.mjs` is its own PR). This file pins the
 * SHAPES so:
 *
 *   - The aggregator (`steuerbelege/layer4-aggregate`) can declare which
 *     scope each contribution came from.
 *   - The verifier (`verifyProvenance`) can assert every contribution's
 *     `ruleId` resolves in the registry.
 *   - Future doc-local stages and bundle-cross-doc stages can speak
 *     a common type.
 *
 * No runtime, no dependencies — pure type declarations + frozen vocabulary.
 */

import type {
  ECode,
  ECodeContribution,
  ECodeValue,
  Layer1Result,
  Layer2Result,
  SubDocLayered,
} from './elster.ts';

/**
 * Where in the pipeline a rule may run.
 *
 *   - `doc-local`         — runs once per sub-doc. Reads only that sub-doc's
 *                           Layer1Result/Layer2Result. Output joins the
 *                           sub-doc's own contribution list. Order-independent
 *                           across sub-docs.
 *
 *   - `bundle-cross-doc`  — runs once per bundle. Reads the full
 *                           SubDocLayered[]. Used for sums, counts, conflict
 *                           resolution, entity unification across belege.
 *                           MUST be deterministic on a sorted-by-subDocId
 *                           input.
 */
export type RuleScope = 'doc-local' | 'bundle-cross-doc';

/**
 * The minimal shape every rule must expose. The `predicate` decides
 * whether the rule applies; `project` produces zero-or-more
 * `ECodeContribution`s. Both run synchronously — rule logic is pure.
 *
 * The generic parameter `TIn` is the bound input type:
 *   - For `doc-local` rules: `Layer1Result | Layer2Result`
 *   - For `bundle-cross-doc` rules: `ReadonlyArray<SubDocLayered>`
 *
 * Implementations narrow `TIn` accordingly.
 */
export interface ProjectionRule<TIn = unknown> {
  /** Stable rule id, namespaced by vertical: `elster/E0108405-spende-sum`. */
  readonly id: string;
  /** Where in the pipeline this rule runs. */
  readonly scope: RuleScope;
  /** Human-readable rule description. Goes into ECodeContribution. */
  readonly description: string;
  /** §-Reference into the legal source, when applicable. */
  readonly rechtsgrundlage?: string;
  /** eCodes this rule may emit. Used for forward-indexing the registry. */
  readonly emits: ReadonlyArray<ECode>;
  /** Cheap pre-check; returns false to skip the project() call entirely. */
  predicate(input: TIn): boolean;
  /**
   * Project the input into zero-or-more contributions. The contributions'
   * `ruleDescription` should match `this.description` so the verifier can
   * cross-check. Implementations MUST be pure.
   */
  project(input: TIn): ProjectionResult;
}

/**
 * Output of a single rule's `project()` call. Aggregator merges these
 * into the per-code contribution list.
 */
export interface ProjectionResult {
  readonly contributions: ReadonlyArray<ECodeContribution>;
  /**
   * Sub-doc IDs the rule explicitly chose NOT to contribute for, with
   * a reason. Surfaces in `BundleAggregateOutput.skipped[]` when no
   * other rule contributes for that sub-doc + scope.
   */
  readonly abstained?: ReadonlyArray<{
    readonly subDocId: string;
    readonly reason: string;
  }>;
}

/**
 * The shape an in-memory rule registry must expose. Implementations live
 * outside this package (one per vertical: `elster/lib/rules.ts`,
 * `bosch/lib/rules.ts`, …). The aggregator and verifier consume this
 * interface only.
 */
export interface RuleRegistry {
  readonly vertical: string;
  readonly version: string; // semver
  /** All rules in registration order. Order is observable. */
  all(): ReadonlyArray<ProjectionRule>;
  /** Subset by scope. */
  byScope(scope: RuleScope): ReadonlyArray<ProjectionRule>;
  /** Lookup by id; null if absent (used by verifyProvenance). */
  get(id: string): ProjectionRule | null;
}

// ─── compile-time helpers ─────────────────────────────────────────────────

export type DocLocalRule = ProjectionRule<Layer1Result | Layer2Result>;
export type BundleCrossDocRule = ProjectionRule<ReadonlyArray<SubDocLayered>>;

/** Type narrowing helper for a `doc-local` rule. */
export const isDocLocalRule = (r: ProjectionRule): r is DocLocalRule =>
  r.scope === 'doc-local';

/** Type narrowing helper for a `bundle-cross-doc` rule. */
export const isBundleCrossDocRule = (r: ProjectionRule): r is BundleCrossDocRule =>
  r.scope === 'bundle-cross-doc';

/**
 * Cheap commutativity property for doc-local rules: applying the rule
 * to sub-docs in any order must produce the same set of contributions
 * (up to ordering). Test helper, not enforced at runtime.
 */
export interface RuleCommutativityCheck {
  readonly ruleId: string;
  readonly subDocCount: number;
  readonly distinctOutputs: number;
  readonly ok: boolean;
}

// re-export ECode-related types so `import { ProjectionRule, ECode } from '@0711/gitchain-types'`
// works without a second import line for consumers.
export type {
  ECode,
  ECodeContribution,
  ECodeValue,
  Layer1Result,
  Layer2Result,
  SubDocLayered,
};
