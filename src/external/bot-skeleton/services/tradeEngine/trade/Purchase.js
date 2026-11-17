import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { paperTrading } from '@/nexus/paper-trading';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }
            const activeAccountId = api_base.account_info?.loginid || this.accountInfo?.loginid;
            const isPaperAccount = paperTrading.isActive(activeAccountId);

            // Nexus copy trading: send the same contract to the followers' accounts (see src/nexus/store.ts)
            if (!isPaperAccount) {
                try {
                    window.__nexusMirror?.(tradeOptionToBuy(contract_type, this.tradeOptions).parameters);
                } catch (e) {
                    // copying must never stop the bot
                }
            }

            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const buy = response?.buy;
                if (!buy) {
                    return;
                }

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.last_activity_at = Date.now();
                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            // The target account uses the local paper engine for every Bot Builder purchase.
            // This branch runs before either live `buy` request below.
            if (isPaperAccount) {
                let quote;
                const parameters = tradeOptionToBuy(contract_type, this.tradeOptions).parameters;
                if (this.is_proposal_subscription_required) {
                    quote = this.data.proposals.find(
                        proposal =>
                            proposal.contract_type === contract_type &&
                            proposal.purchase_reference === this.getPurchaseReference() &&
                            !proposal.error
                    );
                }

                const amount = parameters?.amount ?? this.tradeOptions?.amount;
                contractStatus({ id: 'contract.purchase_sent', data: amount });
                this.isSold = false;

                return paperTrading
                    .openTrade({
                        accountId: activeAccountId,
                        currency: api_base.account_info?.currency || this.accountInfo?.currency || 'USD',
                        parameters,
                        contractType: contract_type,
                        source: 'bot',
                        quote,
                    })
                    .then(result => {
                        if (!result.ok || !result.buy) {
                            return Promise.reject(new Error(result.error || 'Paper trade could not be opened.'));
                        }
                        return onSuccess({ buy: result.buy });
                    });
            }

            // Demo trade limit applies to live purchases, not local paper-mode purchases.
            if (window.__nexusDemoGuard?.()) {
                return new Promise(() => {});
            }

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // if disconnected no need to resubscription (handled by live-api)
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
