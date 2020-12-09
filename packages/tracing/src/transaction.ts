import { getCurrentHub, Hub } from '@sentry/hub';
import { Event, Measurements, Transaction as TransactionInterface, TransactionContext } from '@sentry/types';
import { isInstanceOf, logger, unicodeToBase64 } from '@sentry/utils';

import { Span as SpanClass, SpanRecorder } from './span';

/** JSDoc */
export class Transaction extends SpanClass implements TransactionInterface {
  public name: string;

  public readonly tracestate: string;

  private _measurements: Measurements = {};

  /**
   * The reference to the current hub.
   */
  private readonly _hub: Hub;

  private readonly _trimEnd?: boolean;

  /**
   * This constructor should never be called manually. Those instrumenting tracing should use
   * `Sentry.startTransaction()`, and internal methods should use `hub.startTransaction()`.
   * @internal
   * @hideconstructor
   * @hidden
   */
  public constructor(transactionContext: TransactionContext, hub?: Hub) {
    super(transactionContext);

    this._hub = hub && isInstanceOf(hub, Hub) ? hub : getCurrentHub();

    this.name = transactionContext.name || '';

    this._trimEnd = transactionContext.trimEnd;

    // _getNewTracestate only returns undefined in the absence of a client or dsn, in which case it doesn't matter what
    // the header values are - nothing can be sent anyway - so the third alternative here is just to make TS happy
    this.tracestate = transactionContext.tracestate || this._getNewTracestate() || 'things are broken';

    // this is because transactions are also spans, and spans have a transaction pointer
    this.transaction = this;
  }

  /**
   * JSDoc
   */
  public setName(name: string): void {
    this.name = name;
  }

  /**
   * Attaches SpanRecorder to the span itself
   * @param maxlen maximum number of spans that can be recorded
   */
  public initSpanRecorder(maxlen: number = 1000): void {
    if (!this.spanRecorder) {
      this.spanRecorder = new SpanRecorder(maxlen);
    }
    this.spanRecorder.add(this);
  }

  /**
   * Set observed measurements for this transaction.
   * @hidden
   */
  public setMeasurements(measurements: Measurements): void {
    this._measurements = { ...measurements };
  }

  /**
   * @inheritDoc
   */
  public finish(endTimestamp?: number): string | undefined {
    // This transaction is already finished, so we should not flush it again.
    if (this.endTimestamp !== undefined) {
      return undefined;
    }

    if (!this.name) {
      logger.warn('Transaction has no name, falling back to `<unlabeled transaction>`.');
      this.name = '<unlabeled transaction>';
    }

    // just sets the end timestamp
    super.finish(endTimestamp);

    if (this.sampled !== true) {
      // At this point if `sampled !== true` we want to discard the transaction.
      logger.log('[Tracing] Discarding transaction because its trace was not chosen to be sampled.');
      return undefined;
    }

    const finishedSpans = this.spanRecorder ? this.spanRecorder.spans.filter(s => s !== this && s.endTimestamp) : [];

    if (this._trimEnd && finishedSpans.length > 0) {
      this.endTimestamp = finishedSpans.reduce((prev: SpanClass, current: SpanClass) => {
        if (prev.endTimestamp && current.endTimestamp) {
          return prev.endTimestamp > current.endTimestamp ? prev : current;
        }
        return prev;
      }).endTimestamp;
    }

    const transactionEvent: Event = {
      contexts: {
        trace: this.getTraceContext(),
      },
      spans: finishedSpans,
      start_timestamp: this.startTimestamp,
      tags: this.tags,
      timestamp: this.endTimestamp,
      tracestate: this.tracestate,
      transaction: this.name,
      type: 'transaction',
    };

    const hasMeasurements = Object.keys(this._measurements).length > 0;

    if (hasMeasurements) {
      logger.log('[Measurements] Adding measurements to transaction', JSON.stringify(this._measurements, undefined, 2));
      transactionEvent.measurements = this._measurements;
    }

    transactionEvent.tracestate = this.tracestate;

    return this._hub.captureEvent(transactionEvent);
  }

  /**
   * Create a new tracestate header value
   *
   * @returns The new tracestate value, or undefined if there's no client or no dsn
   */
  private _getNewTracestate(): string | undefined {
    const client = this._hub.getClient();
    const dsn = client?.getDsn();

    if (!client || !dsn) {
      return;
    }

    const { environment, release } = client.getOptions() || {};

    const dataStr = JSON.stringify({
      trace_id: this.traceId,
      public_key: dsn.user,
      environment: environment || 'no environment specified',
      release: release || 'no release specified',
    });

    // See https://www.w3.org/TR/trace-context/#tracestate-header-field-values
    // The spec for tracestate header values calls for a string of the form
    //
    //    identifier1=value1,identifier2=value2,...
    //
    // which means the value can't include any equals signs, since they already have meaning. Equals signs are commonly
    // used to pad the end of base64 values though, so we have to make a substitution (periods are legal in the header
    // but not used in base64).
    try {
      return unicodeToBase64(dataStr).replace(/={1,2}$/, '.');
    } catch (err) {
      logger.warn(err);
      return '';
    }
  }
}
