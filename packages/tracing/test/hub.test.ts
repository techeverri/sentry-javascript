/* eslint-disable @typescript-eslint/unbound-method */
import { BrowserClient } from '@sentry/browser';
import { getMainCarrier, Hub } from '@sentry/hub';
import * as hubModule from '@sentry/hub';
import * as utilsModule from '@sentry/utils'; // for mocking
import { base64ToUnicode, getGlobalObject, isNodeEnv, logger } from '@sentry/utils';
import * as nodeHttpModule from 'http';

import { Transaction } from '../src';
import { BrowserTracing } from '../src/browser/browsertracing';
import { addExtensionMethods } from '../src/hubextensions';
import { extractTraceparentData, TRACEPARENT_REGEXP } from '../src/utils';
import { addDOMPropertiesToGlobal, getSymbolObjectKeyByName } from './testutils';

addExtensionMethods();

const mathRandom = jest.spyOn(Math, 'random');

// we have to add things into the real global object (rather than mocking the return value of getGlobalObject) because
// there are modules which call getGlobalObject as they load, which is seemingly too early for jest to intervene
addDOMPropertiesToGlobal(['XMLHttpRequest', 'Event', 'location', 'document']);

describe('Hub', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'warn');
    jest.spyOn(logger, 'log');
    jest.spyOn(utilsModule, 'isNodeEnv');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('transaction creation', () => {
    it('uses inherited values when given in transaction context', () => {
      const transactionContext = {
        name: 'dogpark',
        traceId: '12312012123120121231201212312012',
        parentSpanId: '1121201211212012',
        tracestate: 'doGsaREgReaT==',
      };
      const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
      const transaction = hub.startTransaction(transactionContext);

      expect(transaction).toEqual(expect.objectContaining(transactionContext));
    });

    it('creates a new tracestate value (with the right data) if not given one in transaction context', () => {
      const hub = new Hub(
        new BrowserClient({
          dsn: 'https://dogsarebadatkeepingsecrets@squirrelchasers.ingest.sentry.io/12312012',
          tracesSampleRate: 1,
          release: 'off.leash.park',
          environment: 'dogpark',
        }),
      );
      const transaction = hub.startTransaction({ name: 'FETCH /ball' });

      const b64Value =
        'ewAiAHAAdQBiAGwAaQBjAF8AawBlAHkAIgA6ACIAZABvAGcAcwBhAHIAZQBiAGEAZABhAHQAawBlAGUAcA' +
        'BpAG4AZwBzAGUAYwByAGUAdABzACIALAAiAGUAbgB2AGkAcgBvAG4AbQBlAG4AdAAiADoAIgBkAG8AZwBwAGEAcgBrACIALAAiA' +
        'HIAZQBsAGUAYQBzAGUAIgA6ACIAbwBmAGYALgBsAGUAYQBzAGgALgBwAGEAcgBrACIAfQA.';

      expect(transaction.tracestate).toEqual(b64Value);
      expect(JSON.parse(base64ToUnicode(b64Value.replace('.', '=')))).toEqual({
        environment: 'dogpark',
        public_key: 'dogsarebadatkeepingsecrets',
        release: 'off.leash.park',
      });
    });
  });

  describe('getTransaction()', () => {
    it('should find a transaction which has been set on the scope if sampled = true', () => {
      const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
      const transaction = hub.startTransaction({ name: 'dogpark' });
      transaction.sampled = true;

      hub.configureScope(scope => {
        scope.setSpan(transaction);
      });

      expect(hub.getScope()?.getTransaction()).toBe(transaction);
    });

    it('should find a transaction which has been set on the scope if sampled = false', () => {
      const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
      const transaction = hub.startTransaction({ name: 'dogpark', sampled: false });

      hub.configureScope(scope => {
        scope.setSpan(transaction);
      });

      expect(hub.getScope()?.getTransaction()).toBe(transaction);
    });

    it("should not find an open transaction if it's not on the scope", () => {
      const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
      hub.startTransaction({ name: 'dogpark' });

      expect(hub.getScope()?.getTransaction()).toBeUndefined();
    });
  });

  describe('transaction sampling', () => {
    describe('default sample context', () => {
      it('should extract request data for default sampling context when in node', () => {
        // make sure we look like we're in node
        (isNodeEnv as jest.Mock).mockReturnValue(true);

        // pre-normalization request object
        const mockRequestObject = ({
          headers: { ears: 'furry', nose: 'wet', tongue: 'panting', cookie: 'favorite=zukes' },
          method: 'wagging',
          protocol: 'mutualsniffing',
          hostname: 'the.dog.park',
          originalUrl: '/by/the/trees/?chase=me&please=thankyou',
        } as unknown) as nodeHttpModule.IncomingMessage;

        // The "as unknown as nodeHttpModule.IncomingMessage" casting above keeps TS happy, but doesn't actually mean that
        // mockRequestObject IS an instance of our desired class. Fix that so that when we search for it by type, we
        // actually find it.
        Object.setPrototypeOf(mockRequestObject, nodeHttpModule.IncomingMessage.prototype);

        // in production, the domain will have at minimum the request and the response, so make a response object to prove
        // that our code identifying the request in domain.members works
        const mockResponseObject = new nodeHttpModule.ServerResponse(mockRequestObject);

        // normally the node request handler does this, but that's not part of this test
        (getMainCarrier().__SENTRY__!.extensions as any).domain = {
          active: { members: [mockRequestObject, mockResponseObject] },
        };

        // Ideally we'd use a NodeClient here, but @sentry/tracing can't depend on @sentry/node since the reverse is
        // already true (node's request handlers start their own transactions) - even as a dev dependency. Fortunately,
        // we're not relying on anything other than the client having a captureEvent method, which all clients do (it's
        // in the abstract base class), so a BrowserClient will do.
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        // post-normalization request object
        expect(tracesSampler).toHaveBeenCalledWith(
          expect.objectContaining({
            request: {
              headers: { ears: 'furry', nose: 'wet', tongue: 'panting', cookie: 'favorite=zukes' },
              method: 'wagging',
              url: 'http://the.dog.park/by/the/trees/?chase=me&please=thankyou',
              cookies: { favorite: 'zukes' },
              query_string: 'chase=me&please=thankyou',
            },
          }),
        );
      });

      it('should extract window.location/self.location for default sampling context when in browser/service worker', () => {
        // make sure we look like we're in the browser
        (isNodeEnv as jest.Mock).mockReturnValue(false);

        const dogParkLocation = {
          hash: '#next-to-the-fountain',
          host: 'the.dog.park',
          hostname: 'the.dog.park',
          href: 'mutualsniffing://the.dog.park/by/the/trees/?chase=me&please=thankyou#next-to-the-fountain',
          origin: "'mutualsniffing://the.dog.park",
          pathname: '/by/the/trees/',
          port: '',
          protocol: 'mutualsniffing:',
          search: '?chase=me&please=thankyou',
        };

        getGlobalObject<Window>().location = dogParkLocation as any;

        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalledWith(expect.objectContaining({ location: dogParkLocation }));
      });

      it('should add transaction context data to default sample context', () => {
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const transactionContext = {
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: true,
        };

        hub.startTransaction(transactionContext);

        expect(tracesSampler).toHaveBeenLastCalledWith(expect.objectContaining({ transactionContext }));
      });

      it("should add parent's sampling decision to default sample context", () => {
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const parentSamplingDecsion = false;

        hub.startTransaction({
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: parentSamplingDecsion,
        });

        expect(tracesSampler).toHaveBeenLastCalledWith(
          expect.objectContaining({ parentSampled: parentSamplingDecsion }),
        );
      });
    });

    describe('sample()', () => {
      it('should not sample transactions when tracing is disabled', () => {
        // neither tracesSampleRate nor tracesSampler is defined -> tracing disabled
        const hub = new Hub(new BrowserClient({}));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(transaction.sampled).toBe(false);
      });

      it('should set sampled = false if tracesSampleRate is 0', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 0 }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(transaction.sampled).toBe(false);
      });

      it('should set sampled = true if tracesSampleRate is 1', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(transaction.sampled).toBe(true);
      });

      it("should call tracesSampler if it's defined", () => {
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalled();
      });

      it('should set sampled = false if tracesSampler returns 0', () => {
        const tracesSampler = jest.fn().mockReturnValue(0);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalled();
        expect(transaction.sampled).toBe(false);
      });

      it('should set sampled = true if tracesSampler returns 1', () => {
        const tracesSampler = jest.fn().mockReturnValue(1);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalled();
        expect(transaction.sampled).toBe(true);
      });

      it('should not try to override positive sampling decision provided in transaction context', () => {
        // so that the decision otherwise would be false
        const tracesSampler = jest.fn().mockReturnValue(0);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const transaction = hub.startTransaction({ name: 'dogpark', sampled: true });

        expect(transaction.sampled).toBe(true);
      });

      it('should not try to override negative sampling decision provided in transaction context', () => {
        // so that the decision otherwise would be true
        const tracesSampler = jest.fn().mockReturnValue(1);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const transaction = hub.startTransaction({ name: 'dogpark', sampled: false });

        expect(transaction.sampled).toBe(false);
      });

      it('should prefer tracesSampler to tracesSampleRate', () => {
        // make the two options do opposite things to prove precedence
        const tracesSampler = jest.fn().mockReturnValue(true);
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 0, tracesSampler }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalled();
        expect(transaction.sampled).toBe(true);
      });

      it('should tolerate tracesSampler returning a boolean', () => {
        const tracesSampler = jest.fn().mockReturnValue(true);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalled();
        expect(transaction.sampled).toBe(true);
      });
    });

    describe('isValidSampleRate()', () => {
      it("should reject tracesSampleRates which aren't numbers or booleans", () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 'dogs!' as any }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be a boolean or a number'));
      });

      it('should reject tracesSampleRates which are NaN', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 'dogs!' as any }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be a boolean or a number'));
      });

      // the rate might be a boolean, but for our purposes, false is equivalent to 0 and true is equivalent to 1
      it('should reject tracesSampleRates less than 0', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: -26 }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be between 0 and 1'));
      });

      // the rate might be a boolean, but for our purposes, false is equivalent to 0 and true is equivalent to 1
      it('should reject tracesSampleRates greater than 1', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 26 }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be between 0 and 1'));
      });

      it("should reject tracesSampler return values which aren't numbers or booleans", () => {
        const tracesSampler = jest.fn().mockReturnValue('dogs!');
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be a boolean or a number'));
      });

      it('should reject tracesSampler return values which are NaN', () => {
        const tracesSampler = jest.fn().mockReturnValue(NaN);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be a boolean or a number'));
      });

      // the rate might be a boolean, but for our purposes, false is equivalent to 0 and true is equivalent to 1
      it('should reject tracesSampler return values less than 0', () => {
        const tracesSampler = jest.fn().mockReturnValue(-12);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be between 0 and 1'));
      });

      // the rate might be a boolean, but for our purposes, false is equivalent to 0 and true is equivalent to 1
      it('should reject tracesSampler return values greater than 1', () => {
        const tracesSampler = jest.fn().mockReturnValue(31);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be between 0 and 1'));
      });
    });

    it('should drop transactions with sampled = false', () => {
      const client = new BrowserClient({ tracesSampleRate: 0 });
      jest.spyOn(client, 'captureEvent');

      const hub = new Hub(client);
      const transaction = hub.startTransaction({ name: 'dogpark' });

      jest.spyOn(transaction, 'finish');
      transaction.finish();

      expect(transaction.sampled).toBe(false);
      expect(transaction.finish).toReturnWith(undefined);
      expect(client.captureEvent).not.toBeCalled();
    });

    describe('sampling inheritance', () => {
      it('should propagate sampling decision to child spans', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: Math.random() }));
        const transaction = hub.startTransaction({ name: 'dogpark' });
        const child = transaction.startChild({ op: 'ball.chase' });

        expect(child.sampled).toBe(transaction.sampled);
      });

      it('should propagate positive sampling decision to child transactions in XHR header', () => {
        const hub = new Hub(
          new BrowserClient({
            dsn: 'https://1231@dogs.are.great/1121',
            tracesSampleRate: 1,
            integrations: [new BrowserTracing()],
          }),
        );
        jest.spyOn(hubModule, 'getCurrentHub').mockReturnValue(hub);

        const transaction = hub.startTransaction({ name: 'dogpark' });
        hub.configureScope(scope => {
          scope.setSpan(transaction);
        });

        const request = new XMLHttpRequest();
        request.open('GET', '/chase-partners');

        // mock a response having been received successfully (we have to do it in this roundabout way because readyState
        // is readonly and changing it doesn't trigger a readystatechange event)
        Object.defineProperty(request, 'readyState', { value: 4 });
        request.dispatchEvent(new Event('readystatechange'));

        // this looks weird, it's true, but it's really just `request.impl.flag.requestHeaders` - it's just that the
        // `impl` key is a symbol rather than a string, and therefore needs to be referred to by reference rather than
        // value
        const headers = (request as any)[getSymbolObjectKeyByName(request, 'impl') as symbol].flag.requestHeaders;

        // check that sentry-trace header is added to request
        expect(headers).toEqual(expect.objectContaining({ 'sentry-trace': expect.stringMatching(TRACEPARENT_REGEXP) }));

        // check that sampling decision is passed down correctly
        expect(transaction.sampled).toBe(true);
        expect(extractTraceparentData(headers['sentry-trace'])!.parentSampled).toBe(true);
      });

      it('should propagate negative sampling decision to child transactions in XHR header', () => {
        const hub = new Hub(
          new BrowserClient({
            dsn: 'https://1231@dogs.are.great/1121',
            tracesSampleRate: 1,
            integrations: [new BrowserTracing()],
          }),
        );
        jest.spyOn(hubModule, 'getCurrentHub').mockReturnValue(hub);

        const transaction = hub.startTransaction({ name: 'dogpark', sampled: false });
        hub.configureScope(scope => {
          scope.setSpan(transaction);
        });

        const request = new XMLHttpRequest();
        request.open('GET', '/chase-partners');

        // mock a response having been received successfully (we have to do it in this roundabout way because readyState
        // is readonly and changing it doesn't trigger a readystatechange event)
        Object.defineProperty(request, 'readyState', { value: 4 });
        request.dispatchEvent(new Event('readystatechange'));

        // this looks weird, it's true, but it's really just `request.impl.flag.requestHeaders` - it's just that the
        // `impl` key is a symbol rather than a string, and therefore needs to be referred to by reference rather than
        // value
        const headers = (request as any)[getSymbolObjectKeyByName(request, 'impl') as symbol].flag.requestHeaders;

        // check that sentry-trace header is added to request
        expect(headers).toEqual(expect.objectContaining({ 'sentry-trace': expect.stringMatching(TRACEPARENT_REGEXP) }));

        // check that sampling decision is passed down correctly
        expect(transaction.sampled).toBe(false);
        expect(extractTraceparentData(headers['sentry-trace'])!.parentSampled).toBe(false);
      });

      it('should propagate positive sampling decision to child transactions in fetch header', () => {
        // TODO
      });

      it('should propagate negative sampling decision to child transactions in fetch header', () => {
        // TODO
      });

      it("should inherit parent's positive sampling decision if tracesSampler is undefined", () => {
        // we know that without inheritance  we'll get sampled = false (since our "random" number won't be below the
        // sample rate), so make parent's decision the opposite to prove that inheritance takes precedence over
        // tracesSampleRate
        mathRandom.mockReturnValueOnce(1);
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 0.5 }));
        const parentSamplingDecsion = true;

        const transaction = hub.startTransaction({
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: parentSamplingDecsion,
        });

        expect(transaction.sampled).toBe(parentSamplingDecsion);
      });

      it("should inherit parent's negative sampling decision if tracesSampler is undefined", () => {
        // tracesSampleRate = 1 means every transaction should end up with sampled = true, so make parent's decision the
        // opposite to prove that inheritance takes precedence over tracesSampleRate
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
        const parentSamplingDecsion = false;

        const transaction = hub.startTransaction({
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: parentSamplingDecsion,
        });

        expect(transaction.sampled).toBe(parentSamplingDecsion);
      });

      it("should ignore parent's positive sampling decision when tracesSampler is defined", () => {
        // this tracesSampler causes every transaction to end up with sampled = true, so make parent's decision the
        // opposite to prove that tracesSampler takes precedence over inheritance
        const tracesSampler = () => true;
        const parentSamplingDecsion = false;

        const hub = new Hub(new BrowserClient({ tracesSampler }));

        const transaction = hub.startTransaction({
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: parentSamplingDecsion,
        });

        expect(transaction.sampled).not.toBe(parentSamplingDecsion);
      });

      it("should ignore parent's negative sampling decision when tracesSampler is defined", () => {
        // this tracesSampler causes every transaction to end up with sampled = false, so make parent's decision the
        // opposite to prove that tracesSampler takes precedence over inheritance
        const tracesSampler = () => false;
        const parentSamplingDecsion = true;

        const hub = new Hub(new BrowserClient({ tracesSampler }));

        const transaction = hub.startTransaction({
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: parentSamplingDecsion,
        });

        expect(transaction.sampled).not.toBe(parentSamplingDecsion);
      });
    });
  });
});
