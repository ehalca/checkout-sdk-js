import { createAction, Action } from '@bigcommerce/data-store';
import { omit } from 'lodash';
import { Observable } from 'rxjs';

import { getBillingAddress } from '../../../billing/internal-billing-addresses.mock';
import { getCart } from '../../../cart/internal-carts.mock';
import { createCheckoutClient, CheckoutSelector, CheckoutStore } from '../../../checkout';
import { MissingDataError, StandardError } from '../../../common/error/errors';
import { getLegacyAppConfig } from '../../../config/configs.mock.js';
import { OrderActionCreator, OrderRequestBody } from '../../../order';
import { getOrderRequestBody } from '../../../order/internal-orders.mock';
import { SUBMIT_ORDER_REQUESTED } from '../../../order/order-action-types';
import PaymentActionCreator from '../../payment-action-creator';
import { SUBMIT_PAYMENT_REQUESTED } from '../../payment-action-types';
import PaymentMethod from '../../payment-method';
import PaymentMethodActionCreator from '../../payment-method-action-creator';
import { getBraintreePaypal } from '../../payment-methods.mock';
import { PaymentInitializeOptions } from '../../payment-request-options';

import BraintreePaymentProcessor from './braintree-payment-processor';
import BraintreePaypalPaymentStrategy from './braintree-paypal-payment-strategy';

describe('BraintreePaypalPaymentStrategy', () => {
    let orderActionCreator: OrderActionCreator;
    let paymentActionCreator: PaymentActionCreator;
    let paymentMethodActionCreator: PaymentMethodActionCreator;
    let braintreePaymentProcessorMock: BraintreePaymentProcessor;
    let braintreePaypalPaymentStrategy: BraintreePaypalPaymentStrategy;
    let paymentMethodMock: PaymentMethod;
    let checkoutMock: CheckoutSelector;
    let store: CheckoutStore;
    let submitOrderAction: Observable<Action>;
    let submitPaymentAction: Observable<Action>;

    beforeEach(() => {
        braintreePaymentProcessorMock = {} as BraintreePaymentProcessor;
        braintreePaymentProcessorMock.initialize = jest.fn();
        braintreePaymentProcessorMock.preloadPaypal = jest.fn(() => Promise.resolve());
        braintreePaymentProcessorMock.paypal = jest.fn(() => Promise.resolve({ nonce: 'my_tokenized_card' }));
        braintreePaymentProcessorMock.appendSessionId = jest.fn(tokenizedCard => tokenizedCard.then(card => ({ ...card, deviceSessionId: 'my_session_id' })));
        braintreePaymentProcessorMock.deinitialize = jest.fn();

        paymentMethodMock = { ...getBraintreePaypal(), clientToken: 'myToken' };
        submitOrderAction = Observable.of(createAction(SUBMIT_ORDER_REQUESTED));
        submitPaymentAction = Observable.of(createAction(SUBMIT_PAYMENT_REQUESTED));

        checkoutMock = {} as CheckoutSelector;
        checkoutMock.getPaymentMethod = jest.fn(() => paymentMethodMock);
        checkoutMock.isPaymentDataRequired = jest.fn((useStoreCredit: boolean) => true);

        store = {} as CheckoutStore;
        store.dispatch = jest.fn(() => Promise.resolve({ checkout: checkoutMock }));
        store.getState = jest.fn(() => ({ checkout: checkoutMock }));

        orderActionCreator = {} as OrderActionCreator;
        orderActionCreator.submitOrder = jest.fn(() => submitOrderAction);

        paymentActionCreator = {} as PaymentActionCreator;
        paymentActionCreator.submitPayment = jest.fn(() => submitPaymentAction);

        paymentMethodActionCreator = new PaymentMethodActionCreator(createCheckoutClient());
        braintreePaypalPaymentStrategy = new BraintreePaypalPaymentStrategy(
            store,
            orderActionCreator,
            paymentActionCreator,
            paymentMethodActionCreator,
            braintreePaymentProcessorMock
        );
    });

    it('creates an instance of the braintree payment strategy', () => {
        expect(braintreePaypalPaymentStrategy).toBeInstanceOf(BraintreePaypalPaymentStrategy);
    });

    describe('#initialize()', () => {
        it('initializes the braintree payment processor with the client token and the set of options', async () => {
            const options = { methodId: paymentMethodMock.id, braintree: {} };

            await braintreePaypalPaymentStrategy.initialize(options);

            expect(braintreePaymentProcessorMock.initialize).toHaveBeenCalledWith('myToken', options.braintree);
        });

        it('preloads paypal', async () => {
            await braintreePaypalPaymentStrategy.initialize({ methodId: paymentMethodMock.id });

            expect(braintreePaymentProcessorMock.preloadPaypal).toHaveBeenCalled();
        });

        it('skips all initialization if a nonce is present in the paymentProvider', async () => {
            paymentMethodMock.nonce = 'some-nonce';

            await braintreePaypalPaymentStrategy.initialize({ methodId: paymentMethodMock.id });

            expect(braintreePaymentProcessorMock.preloadPaypal).not.toHaveBeenCalled();
            expect(braintreePaymentProcessorMock.initialize).not.toHaveBeenCalled();
        });

        it('throws error if unable to initialize', async () => {
            paymentMethodMock.clientToken = undefined;

            try {
                await braintreePaypalPaymentStrategy.initialize({ methodId: paymentMethodMock.id });
            } catch (error) {
                expect(error).toBeInstanceOf(MissingDataError);
            }
        });
    });

    describe('#execute()', () => {
        let orderRequestBody: OrderRequestBody;
        let options: PaymentInitializeOptions;

        beforeEach(() => {
            orderRequestBody = getOrderRequestBody();
            options = { methodId: getBraintreePaypal().id };

            checkoutMock.getCart = jest.fn(() => getCart());
            checkoutMock.getBillingAddress = jest.fn(() => getBillingAddress());
            checkoutMock.getConfig = jest.fn(() => getLegacyAppConfig());

            return braintreePaypalPaymentStrategy.initialize(options);
        });

        it('calls submit order with the order request information', async () => {
            await braintreePaypalPaymentStrategy.execute(orderRequestBody, options);

            expect(orderActionCreator.submitOrder).toHaveBeenCalledWith(omit(orderRequestBody, 'payment'), expect.any(Boolean), expect.any(Object));
            expect(store.dispatch).toHaveBeenCalledWith(submitOrderAction);
        });

        it('asks for cart verification', async () => {
            await braintreePaypalPaymentStrategy.execute(orderRequestBody, options);

            expect(orderActionCreator.submitOrder).toHaveBeenCalledWith(expect.any(Object), true, expect.any(Object));
        });

        it('pass the options to submitOrder', async () => {
            await braintreePaypalPaymentStrategy.execute(orderRequestBody, options);

            expect(orderActionCreator.submitOrder).toHaveBeenCalledWith(expect.any(Object), expect.any(Boolean), options);
        });

        it('submitPayment with the right information', async () => {
            const expected = {
                ...orderRequestBody.payment,
                paymentData: {
                    deviceSessionId: 'my_session_id',
                    method: 'paypal',
                    nonce: 'my_tokenized_card',
                },
            };

            await braintreePaypalPaymentStrategy.execute(orderRequestBody, options);

            expect(braintreePaymentProcessorMock.paypal).toHaveBeenCalledWith(190, 'en_US', 'USD', false);
            expect(paymentActionCreator.submitPayment).toHaveBeenCalledWith(expected);
            expect(store.dispatch).toHaveBeenCalledWith(submitPaymentAction);
        });

        it('does not call paypal if a nonce is present', async () => {
            paymentMethodMock.nonce = 'some-nonce';

            const expected = expect.objectContaining({
                paymentData: {
                    method: 'paypal',
                    nonce: 'some-nonce',
                },
            });

            await braintreePaypalPaymentStrategy.initialize({ methodId: paymentMethodMock.id });
            await braintreePaypalPaymentStrategy.execute(orderRequestBody, options);

            expect(braintreePaymentProcessorMock.paypal).not.toHaveBeenCalled();
            expect(paymentActionCreator.submitPayment).toHaveBeenCalledWith(expected);
            expect(store.dispatch).toHaveBeenCalledWith(submitPaymentAction);
        });

        it('converts any error returned by braintree in a StandardError', async () => {
            braintreePaymentProcessorMock.paypal = () => Promise.reject({ name: 'BraintreeError', message: 'my_message'});

            await expect(braintreePaypalPaymentStrategy.execute(orderRequestBody, options)).rejects.toEqual(expect.any(StandardError));
        });

        describe('if paypal credit', () => {
            beforeEach(() => {
                braintreePaypalPaymentStrategy = new BraintreePaypalPaymentStrategy(
                    store,
                    orderActionCreator,
                    paymentActionCreator,
                    paymentMethodActionCreator,
                    braintreePaymentProcessorMock,
                    true
                );
            });

            it('submitPayment with the right information and sets credit to true', async () => {
                const expected = {
                    ...orderRequestBody.payment,
                    paymentData: {
                        deviceSessionId: 'my_session_id',
                        method: 'paypal',
                        nonce: 'my_tokenized_card',
                    },
                };

                await braintreePaypalPaymentStrategy.initialize(options);
                await braintreePaypalPaymentStrategy.execute(orderRequestBody, options);

                expect(braintreePaymentProcessorMock.paypal).toHaveBeenCalledWith(190, 'en_US', 'USD', true);
                expect(paymentActionCreator.submitPayment).toHaveBeenCalledWith(expected);
                expect(store.dispatch).toHaveBeenCalledWith(submitPaymentAction);
            });
        });
    });

    describe('#deinitialize()', () => {
        it('calls deinitialize in the braintree payment processor', async () => {
            braintreePaymentProcessorMock.deinitialize = jest.fn(() => Promise.resolve());

            await braintreePaypalPaymentStrategy.deinitialize({ methodId: paymentMethodMock.id });

            expect(braintreePaymentProcessorMock.deinitialize).toHaveBeenCalled();
        });
    });
});
