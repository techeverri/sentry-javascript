import { Event, SentryRequest, Session } from '@sentry/types';
import { base64ToUnicode, logger } from '@sentry/utils';

import { API } from './api';

/**
 * Create a SentryRequest from an error, message, or transaction event.
 *
 * @param event The event to send
 * @param api Helper to provide the correct url for the request
 * @returns SentryRequest representing the event
 */
export function eventToSentryRequest(event: Event, api: API): SentryRequest {
  if (event.type === 'transaction') {
    return transactionToSentryRequest(event, api);
  }
  return {
    body: JSON.stringify(event),
    type: event.type || 'event',
    url: api.getStoreEndpointWithUrlEncodedAuth(),
  };
}

/**
 * Create a SentryRequest from a transaction event.
 *
 * Since we don't need to manipulate envelopes nor store them, there is no exported concept of an Envelope with
 * operations including serialization and deserialization. Instead, we only implement a minimal subset of the spec to
 * serialize events inline here. See https://develop.sentry.dev/sdk/envelopes/.
 *
 * @param event The transaction event to send
 * @param api Helper to provide the correct url for the request
 * @returns SentryRequest in envelope form
 */
export function transactionToSentryRequest(event: Event, api: API): SentryRequest {
  // because we send event.tracestate as a header whose values have meaningful equals signs, when we create it we have
  // to replace the padding character with something else; the `.replace` call here reverses that to make it valid
  // base64 before converting to unicode for parsing
  let tracestateJSON;
  try {
    tracestateJSON = event.tracestate ? base64ToUnicode(event.tracestate.replace('.', '=')) : undefined;
  } catch (err) {
    logger.warn(err);
    tracestateJSON = '';
  }
  delete event.tracestate;

  const envelopeHeaders = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    trace_id: event.contexts?.trace?.trace_id,
    trace: tracestateJSON, // trace context for dynamic sampling on relay
  });

  const itemHeaders = JSON.stringify({
    type: event.type,
    // The content-type is assumed to be 'application/json' and not part of
    // the current spec for transaction items, so we don't bloat the request
    // body with it.
    //
    // content_type: 'application/json',
    //
    // The length is optional. It must be the number of bytes in req.Body
    // encoded as UTF-8. Since the server can figure this out and would
    // otherwise refuse events that report the length incorrectly, we decided
    // not to send the length to avoid problems related to reporting the wrong
    // size and to reduce request body size.
    //
    // length: new TextEncoder().encode(req.body).length,
  });

  const req: SentryRequest = {
    // The trailing newline is optional; leave it off to avoid sending unnecessary bytes.
    // body: `${envelopeHeaders}\n${itemHeaders}\n${JSON.stringify(event)\n}`,
    body: `${envelopeHeaders}\n${itemHeaders}\n${JSON.stringify(event)}`,
    type: 'transaction',
    url: api.getEnvelopeEndpointWithUrlEncodedAuth(),
  };

  return req;
}

/**
 * Create a SentryRequest from a session event.
 *
 * @param event The session event to send
 * @param api Helper to provide the correct url for the request
 * @returns SentryRequest in envelope form
 */
export function sessionToSentryRequest(session: Session, api: API): SentryRequest {
  const envelopeHeaders = JSON.stringify({
    sent_at: new Date().toISOString(),
  });
  const itemHeaders = JSON.stringify({
    type: 'session',
  });

  return {
    body: `${envelopeHeaders}\n${itemHeaders}\n${JSON.stringify(session)}`,
    type: 'session',
    url: api.getEnvelopeEndpointWithUrlEncodedAuth(),
  };
}
