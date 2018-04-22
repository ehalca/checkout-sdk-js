/// <reference path="../../remote-checkout/methods/klarna/klarna-sdk.d.ts" />

import { omit } from 'lodash';

import { CheckoutSelectors, CheckoutStore } from '../../checkout';
import { InvalidArgumentError, MissingDataError, NotInitializedError } from '../../common/error/errors';
import { OrderActionCreator, OrderRequestBody } from '../../order';
import { RemoteCheckoutActionCreator } from '../../remote-checkout';
import { KlarnaScriptLoader } from '../../remote-checkout/methods/klarna';
import Payment from '../payment';
import PaymentMethodActionCreator from '../payment-method-action-creator';
import { PaymentInitializeOptions, PaymentRequestOptions } from '../payment-request-options';

import PaymentStrategy from './payment-strategy';

export default class KlarnaPaymentStrategy extends PaymentStrategy {
    private _klarnaSdk?: Klarna.Sdk;
    private _unsubscribe?: (() => void);

    constructor(
        store: CheckoutStore,
        private _orderActionCreator: OrderActionCreator,
        private _paymentMethodActionCreator: PaymentMethodActionCreator,
        private _remoteCheckoutActionCreator: RemoteCheckoutActionCreator,
        private _klarnaScriptLoader: KlarnaScriptLoader
    ) {
        super(store);
    }

    initialize(options: PaymentInitializeOptions): Promise<CheckoutSelectors> {
        return this._klarnaScriptLoader.load()
            .then(klarnaSdk => { this._klarnaSdk = klarnaSdk; })
            .then(() => {
                this._unsubscribe = this._store.subscribe(
                    () => this._loadWidget(options),
                    ({ checkout }) => {
                        const cart = checkout.getCart();

                        return cart && cart.grandTotal;
                    }
                );

                return this._loadWidget(options);
            })
            .then(() => super.initialize(options));
    }

    deinitialize(options?: PaymentRequestOptions): Promise<CheckoutSelectors> {
        if (this._unsubscribe) {
            this._unsubscribe();
        }

        return super.deinitialize(options);
    }

    execute(payload: OrderRequestBody, options?: PaymentRequestOptions): Promise<CheckoutSelectors> {
        return this._authorize()
            .then((res: Klarna.AuthorizationResponse) => {
                const authorizationToken = res.authorization_token;

                if (!payload.payment) {
                    throw new InvalidArgumentError('Unable to proceed because "payload.payment.name" argument is not provided.');
                }

                return this._store.dispatch(
                    this._remoteCheckoutActionCreator.initializePayment(payload.payment.name, { authorizationToken })
                );
            })
            .then(() => this._store.dispatch(
                this._orderActionCreator.submitOrder({
                    ...payload,
                    payment: omit(payload.payment, 'paymentData') as Payment,
                    // Note: API currently doesn't support using Store Credit with Klarna.
                    // To prevent deducting customer's store credit, set it as false.
                    useStoreCredit: false,
                }, true, options)
            ));
    }

    private _loadWidget(options: PaymentInitializeOptions): Promise<void> {
        if (!options.klarna) {
            throw new InvalidArgumentError('Unable to load widget because "options.klarna" argument is not provided.');
        }

        const { methodId, klarna: { container, loadCallback } } = options;

        return this._store.dispatch(this._paymentMethodActionCreator.loadPaymentMethod(methodId))
            .then(({ checkout }) => {
                const paymentMethod = checkout.getPaymentMethod(methodId);

                if (!paymentMethod || !paymentMethod.clientToken) {
                    throw new MissingDataError('Unable to load payment widget because "paymentMethod.clientToken" field is missing.');
                }

                if (!this._klarnaSdk) {
                    throw new NotInitializedError();
                }

                this._klarnaSdk.init({ client_token: paymentMethod.clientToken });
                this._klarnaSdk.load({ container }, loadCallback);
            });
    }

    private _authorize(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this._klarnaSdk) {
                throw new NotInitializedError();
            }

            this._klarnaSdk.authorize({}, (res: Klarna.AuthorizationResponse) => {
                if (!res.approved) {
                    reject(res);
                } else {
                    resolve(res);
                }
            });
        });
    }
}

export interface KlarnaPaymentInitializeOptions {
    container: string;
    loadCallback?(): Klarna.LoadResponse;
}
