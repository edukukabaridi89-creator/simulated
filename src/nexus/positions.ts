import { makeAutoObservable } from 'mobx';
import { api_base } from '@/external/bot-skeleton';
import { observer as eventBus } from '@/external/bot-skeleton/utils/observer';
import { paperTrading } from './paper-trading';
import { nexus } from './store';

export type Position = { id: number; type: string; symbol: string; buyPrice: number; bid: number; profit: number; sellable: boolean; closed: boolean; paper: boolean };

/** Contracts opened from the trade pages, for the "open positions" list (with Close). */
class PositionsStore {
    list: Position[] = [];
    constructor() {
        makeAutoObservable(this);
        eventBus.register('paper.position', this.upsert);
        const accountId = (api_base.account_info as any)?.loginid || nexus.getLoginid();
        const currency = (api_base.account_info as any)?.currency || nexus.root?.client?.currency;
        if (accountId && currency) paperTrading.resume(accountId, currency);
    }
    upsert = (c: any) => {
        const next: Position = {
            id: c.contract_id,
            type: c.contract_type,
            symbol: c.underlying ?? c.underlying_symbol ?? '',
            buyPrice: Number(c.buy_price),
            bid: Number(c.bid_price ?? 0),
            profit: Number(c.profit ?? 0),
            sellable: !!Number(c.is_valid_to_sell) && !c.is_sold,
            closed: !!c.is_sold,
            paper: !!c.paper_mode,
        };
        const i = this.list.findIndex(p => p.id === next.id);
        if (i >= 0) this.list[i] = next;
        else this.list.unshift(next);
        if (next.closed) setTimeout(() => this.remove(next.id), 4000);
    };
    remove = (id: number) => {
        this.list = this.list.filter(p => p.id !== id);
    };
}
export const positions = new PositionsStore();

/** Sells (closes) an open contract at the current price. */
export const sellPosition = async (id: number) => {
    const activeAccountId = (api_base.account_info as any)?.loginid || nexus.getLoginid();
    const position = positions.list.find(item => item.id === Number(id));
    if (position?.paper) {
        const result = paperTrading.closeTrade(id);
        if (!result.ok) nexus.log(result.error || 'The paper position could not be closed.');
        return;
    }

    if (paperTrading.isActive(activeAccountId)) {
        nexus.log('This is a live position. Local paper mode will not send a sell order; switch to normal trading to close it.');
        return;
    }

    try {
        const res: any = await api_base.api?.send({ sell: id, price: 0 });
        if (res?.error) nexus.log(res.error.message);
    } catch (e: any) {
        nexus.log(e?.error?.message ?? 'The contract could not be closed.');
    }
};
