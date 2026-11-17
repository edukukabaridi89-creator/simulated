import { getFormattedText } from '@/components/shared';
import DBotStore from '../../../scratch/dbot-store';
import { api_base } from '../../api/api-base';
import { info } from '../utils/broadcast';
import { paperTrading } from '@/nexus/paper-trading';

let balance_string = '';

export default Engine =>
    class Balance extends Engine {
        observeBalance() {
            if (!api_base.api) return;
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data?.msg_type === 'balance' && data?.balance) {
                    const {
                        balance: { balance: b, currency },
                    } = data;

                    const paperBalance = paperTrading.balanceFor(this.accountInfo?.loginid, currency);
                    balance_string = getFormattedText(paperBalance ?? b, currency);

                    if (this.accountInfo) info({ accountID: this.accountInfo.loginid, balance: balance_string });
                }
            });
            api_base.pushSubscription(subscription);
        }

        // eslint-disable-next-line class-methods-use-this
        getBalance(type) {
            const { client } = DBotStore.instance;
            const paperBalance = client?.loginid
                ? paperTrading.balanceFor(client.loginid, client.currency)
                : null;
            const balance = paperBalance ?? ((client && client.balance) || 0);

            balance_string = getFormattedText(balance, client.currency, false);
            return type === 'STR' ? balance_string : balance;
        }
    };
