import type { MethodName, Methods, ResultReference, WithRefs } from './types';

/** A pending method call inside a batch. Carries its result type for typed lookup. */
export class CallHandle<M extends MethodName> {
  declare readonly _result: Methods[M]['result'];
  constructor(
    readonly name: M,
    readonly id: string,
  ) {}

  /** Back-reference to a JSON pointer inside this call's result (RFC 8620 §3.7). */
  ref(path: string): ResultReference {
    return { resultOf: this.id, name: this.name, path };
  }
}

export type Invocation = [string, Record<string, unknown>, string];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
}

/** Collects method calls for one JMAP request. */
export class RequestBuilder {
  private calls: Invocation[] = [];

  call<M extends MethodName>(name: M, args: WithRefs<Methods[M]['args']>): CallHandle<M> {
    const id = String(this.calls.length);
    this.calls.push([name, args as Record<string, unknown>, id]);
    return new CallHandle(name, id);
  }

  get size(): number {
    return this.calls.length;
  }

  build(using: string[]): JmapRequest {
    return { using, methodCalls: this.calls };
  }
}
