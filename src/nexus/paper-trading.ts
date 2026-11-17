import { makeAutoObservable } from 'mobx';
import { getRoundedNumber } from '@/components/shared';
import { LogTypes } from '@/external/bot-skeleton/constants/messages';
import { observer as eventBus } from '@/external/bot-skeleton/utils/observer';
import { fetchProposal } from './dtrader/market-data';
import { isPaperTarget } from './paper-mode-config';
import { hub } from './ticks-hub';

export { PAPER_TARGET_LOGINID } from './paper-mode-config';

const STORAGE_PREFIX = 'saint-paper-ledger-v1';
const DEFAULT_PAPER_BALANCE = 10_000;
const FALLBACK_DURATION_MS = 60_000;

type PaperLedger = {
    balance: number;
    trades: any[];
};

type PaperTradeRequest = {
    accountId: string;
    currency: string;
    parameters: Record<string, any>;
    contractType?: string;
    source: string;
    quote?: any;
};

type PaperSettlement = { contract_id: number; profit: number; won: boolean };
type LocalQuote = { ok: boolean; cost: number; payout: number; details?: any; error?: string };
type PaperBalanceResult = { ok: true } | { ok: false; error: string };
type PaperCloseResult = { ok: true; trade: any } | { ok: false; error: string };
type PaperOpenTradeResult =
    | { ok: true; trade: any; buy: { contract_id: number; transaction_id: string; buy_price: number; payout: number; start_time: number; shortcode: string; paper_mode: true } }
    | { ok: false; error: string };

const round = (value: number, currency: string) => Number(getRoundedNumber(value, currency));
const ledgerKey = (accountId: string, currency: string) =>
    `${STORAGE_PREFIX}:${accountId}:${currency}`;

const readLedger = (key: string): PaperLedger => {
    try {
        const stored = JSON.parse(localStorage.getItem(key) || 'null');
        if (stored && Number.isFinite(stored.balance) && Array.isArray(stored.trades)) {
            return stored;
        }
    } catch {
        // Ignore invalid or unavailable local storage and start with a clean paper ledger.
    }
    return { balance: DEFAULT_PAPER_BALANCE, trades: [] };
};

const digitAt = (price: number, pipSize = 2) => {
    const fixed = Number(price).toFixed(Math.max(0, Math.min(8, pipSize)));
    return Number(fixed.slice(-1));
};

const durationFor = (parameters: Record<string, any>) => {
    const duration = Number(parameters.duration);
    const unit = String(parameters.duration_unit || 't').toLowerCase();
    if (!Number.isFinite(duration) || duration <= 0) {
        return { ticks: 0, ms: FALLBACK_DURATION_MS };
    }
    if (unit === 't') return { ticks: Math.max(1, Math.floor(duration)), ms: FALLBACK_DURATION_MS };
    const unitMs: Record<string, number> = {
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
    };
    return { ticks: 0, ms: Math.min((unitMs[unit] || 1_000) * duration, 86_400_000) };
};

const normalizeParameters = (input: PaperTradeRequest) => {
    const raw = input.parameters || {};
    const symbol = String(raw.symbol || raw.underlying_symbol || raw.underlying || '');
    const contractType = String(input.contractType || raw.contract_type || '').toUpperCase();
    const amount = Number(raw.stake ?? raw.amount);
    const parameters: Record<string, any> = {
        amount,
        basis: raw.basis || 'stake',
        contract_type: contractType,
        currency: input.currency,
        underlying_symbol: symbol,
    };
    [
        'duration',
        'duration_unit',
        'barrier',
        'barrier2',
        'multiplier',
        'growth_rate',
        'limit_order',
        'deal_cancellation',
        'selected_tick',
        'date_start',
    ].forEach(key => {
        if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') parameters[key] = raw[key];
    });
    return { symbol, contractType, amount, parameters };
};

const isWinningContract = (trade: any, exitPrice: number) => {
    const type = String(trade.contract_type || '').toUpperCase();
    const entry = Number(trade.entry_spot);
    const barrier = Number(trade.barrier);
    const barrier2 = Number(trade.barrier2);
    const digit = digitAt(exitPrice, Number(trade.pip_size) || 2);
    const path: number[] = trade.paper_price_path || trade.price_path || [];

    if (type.includes('DIGITEVEN')) return digit % 2 === 0;
    if (type.includes('DIGITODD')) return digit % 2 === 1;
    if (type.includes('DIGITOVER')) return digit > barrier;
    if (type.includes('DIGITUNDER')) return digit < barrier;
    if (type.includes('DIGITMATCH')) return digit === barrier;
    if (type.includes('DIGITDIFF')) return digit !== barrier;

    if (type.includes('TOUCH')) {
        const touched = path.some(price => price === barrier || (price - entry) * (barrier - entry) >= 0 &&
            Math.abs(price - entry) >= Math.abs(barrier - entry));
        return type.includes('NOTOUCH') ? !touched : touched;
    }
    if (type.includes('RANGE') || type.includes('IN') || type.includes('OUT')) {
        const low = Math.min(barrier, barrier2);
        const high = Math.max(barrier, barrier2);
        const inside = exitPrice >= low && exitPrice <= high;
        return type.includes('OUT') ? !inside : inside;
    }

    if (/PUT|FALL|DOWN|LOWER|SHORT/.test(type)) return exitPrice < entry;
    if (/CALL|RISE|UP|HIGHER|LONG/.test(type)) return exitPrice > entry;
    // The paper simulator uses terminal price direction for contract types without a local rule.
    return exitPrice > entry;
};

class PaperTradingStore {
    ledgers: Record<string, PaperLedger> = {};
    private activeTrades = new Map<number, any>();
    private settleResolvers = new Map<number, (result: PaperSettlement) => void>();
    private tickUnsubscribe: (() => void) | null = null;
    private nextLocalId = 0;

    constructor() {
        makeAutoObservable(this, {
            activeTrades: false,
            settleResolvers: false,
            tickUnsubscribe: false,
            nextLocalId: false,
        });
    }

    isActive = (accountId?: string) => isPaperTarget(accountId);

    private getLedger(accountId: string, currency: string) {
        const key = ledgerKey(accountId, currency);
        if (!this.ledgers[key]) this.ledgers[key] = readLedger(key);
        return this.ledgers[key];
    }

    balanceFor = (accountId: string, currency: string) => {
        if (!this.isActive(accountId)) return null;
        return this.getLedger(accountId, currency).balance;
    };

    setBalance = (accountId: string, currency: string, value: unknown): PaperBalanceResult => {
        if (!this.isActive(accountId)) return { ok: false, error: 'Paper mode is not active.' };
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0) {
            return { ok: false, error: 'Enter a valid balance of zero or more.' };
        }
        const key = ledgerKey(accountId, currency);
        const ledger = this.getLedger(accountId, currency);
        const next = { ...ledger, balance: round(amount, currency) };
        try {
            localStorage.setItem(key, JSON.stringify(next));
        } catch {
            return { ok: false, error: 'Could not save the paper balance on this device.' };
        }
        this.ledgers[key] = next;
        return { ok: true };
    };

    private persist(accountId: string, currency: string, next: PaperLedger) {
        try {
            localStorage.setItem(ledgerKey(accountId, currency), JSON.stringify(next));
            this.ledgers[ledgerKey(accountId, currency)] = next;
            return true;
        } catch {
            return false;
        }
    }

    async openTrade(input: PaperTradeRequest): Promise<PaperOpenTradeResult> {
        if (!this.isActive(input.accountId)) return { ok: false, error: 'Paper mode is not active.' };

        const { symbol, contractType, amount, parameters } = normalizeParameters(input);
        if (!symbol || !contractType || !Number.isFinite(amount) || amount <= 0) {
            return { ok: false, error: 'The paper trade settings are incomplete.' };
        }

        const suppliedQuote = input.quote;
        const quote: LocalQuote = suppliedQuote
            ? {
                  ok: suppliedQuote.ok !== false,
                  cost: Number(suppliedQuote.cost ?? suppliedQuote.ask_price),
                  payout: Number(suppliedQuote.payout),
                  details: suppliedQuote.details || suppliedQuote,
                  error: suppliedQuote.error,
              }
            : (await fetchProposal(parameters)) as LocalQuote;
        if (!quote.ok || !Number.isFinite(quote.cost) || quote.cost <= 0 || !Number.isFinite(quote.payout)) {
            return { ok: false, error: quote.error || 'A paper-trade quote is unavailable.' };
        }

        let spot = Number(hub.feed(symbol)?.last);
        let pipSize = Number(hub.feed(symbol)?.pip);
        if (!Number.isFinite(spot)) {
            try {
                const history = await hub.call({ ticks_history: symbol, end: 'latest', count: 1, style: 'ticks' });
                spot = Number(history?.history?.prices?.[0]);
                pipSize = Number(history?.pip_size) || 2;
            } catch {
                return { ok: false, error: `Could not get a market price for ${symbol}.` };
            }
        }
        if (!Number.isFinite(spot)) return { ok: false, error: `Could not get a market price for ${symbol}.` };

        const { ticks, ms } = durationFor(parameters);
        const id = -(Date.now() * 1000 + (++this.nextLocalId % 1000));
        const buyTransactionId = `PAPER-BUY-${Math.abs(id)}`;
        const durationMs = ms;
        const startTime = Math.floor(Date.now() / 1000);
        const trade = {
            accountID: input.accountId,
            contract_id: id,
            contract_type: contractType,
            underlying: symbol,
            underlying_symbol: symbol,
            shortcode: `PAPER_${contractType}_${symbol}`,
            currency: input.currency,
            buy_price: round(quote.cost, input.currency),
            payout: round(quote.payout, input.currency),
            bid_price: round(quote.cost, input.currency),
            profit: 0,
            date_start: startTime,
            start_time: startTime,
            entry_spot: spot,
            entry_tick: spot,
            exit_spot: undefined,
            barrier: parameters.barrier,
            barrier2: parameters.barrier2,
            duration: ticks ? ticks : undefined,
            duration_unit: ticks ? 't' : 's',
            is_sold: 0,
            is_expired: 0,
            is_valid_to_sell: 1,
            transaction_ids: { buy: buyTransactionId },
            paper_mode: true,
            paper_source: input.source,
            paper_opened_at: Date.now(),
            paper_expiry_at: Date.now() + durationMs,
            paper_target_ticks: ticks,
            paper_start_seq: Number(hub.feed(symbol)?.seq) || 0,
            paper_tick_count: 0,
            paper_price_path: [spot],
            pip_size: pipSize || 2,
        };

        const ledger = this.getLedger(input.accountId, input.currency);
        if (quote.cost > ledger.balance) return { ok: false, error: 'Insufficient paper balance.' };
        const next = {
            balance: round(ledger.balance - quote.cost, input.currency),
            trades: [trade, ...ledger.trades.filter(item => item.contract_id !== id)].slice(0, 5000),
        };
        if (!this.persist(input.accountId, input.currency, next)) {
            return { ok: false, error: 'Could not save the paper trade locally.' };
        }

        this.activeTrades.set(id, trade);
        this.ensureTickListener();
        hub.watch([symbol]);
        this.scheduleExpiry(id, durationMs);
        // Let the Bot Builder finish its local purchase callback and set contractId first.
        setTimeout(() => this.publish(trade), 0);

        return {
            ok: true,
            trade,
            buy: {
                contract_id: id,
                transaction_id: buyTransactionId,
                buy_price: trade.buy_price,
                payout: trade.payout,
                start_time: startTime,
                shortcode: trade.shortcode,
                paper_mode: true,
            },
        };
    }

    waitForSettlement = (id: number): Promise<PaperSettlement> =>
        new Promise<PaperSettlement>(resolve => this.settleResolvers.set(id, resolve));

    closeTrade = (id: number): PaperCloseResult => {
        const trade = this.activeTrades.get(Number(id));
        if (!trade) return { ok: false, error: 'Paper position not found or already closed.' };
        const ledger = this.getLedger(trade.accountID, trade.currency);
        const spot = Number(hub.feed(trade.underlying)?.last ?? trade.entry_spot);
        const won = isWinningContract(trade, spot);
        // An early paper close uses a bounded, local mark estimate; it never calls Deriv's sell endpoint.
        const direction = /PUT|FALL|DOWN|LOWER|SHORT/.test(trade.contract_type) ? -1 : 1;
        const move = (spot - trade.entry_spot) / Math.max(Math.abs(trade.entry_spot), 1) * direction;
        const mark = Math.max(0, Math.min(trade.payout, trade.buy_price * (1 + move * 100)));
        const closeValue = won
            ? Math.max(mark, Math.min(trade.payout, trade.buy_price))
            : Math.min(mark, trade.buy_price);
        return this.settle(id, closeValue, spot, false);
    };

    resume(accountId: string, currency: string) {
        if (!this.isActive(accountId)) return;
        const ledger = this.getLedger(accountId, currency);
        ledger.trades.filter(trade => !trade.is_sold).forEach(trade => {
            let activeTrade = this.activeTrades.get(trade.contract_id);
            if (!activeTrade) {
                activeTrade = trade;
                this.activeTrades.set(trade.contract_id, activeTrade);
                hub.watch([trade.underlying]);
                const remaining = Math.max(0, Number(trade.paper_expiry_at) - Date.now());
                this.scheduleExpiry(trade.contract_id, remaining);
            }
            eventBus.emit('paper.position', activeTrade);
        });
        if (this.activeTrades.size) this.ensureTickListener();
    }

    private ensureTickListener() {
        if (!this.tickUnsubscribe) {
            this.tickUnsubscribe = hub.onTick(symbol => this.onTick(symbol));
        }
    }

    private scheduleExpiry(id: number, ms: number) {
        setTimeout(() => {
            const trade = this.activeTrades.get(id);
            if (!trade) return;
            const spot = Number(hub.feed(trade.underlying)?.last ?? trade.entry_spot);
            const won = isWinningContract(trade, spot);
            this.settle(id, won ? trade.payout : 0, spot, true);
        }, Math.max(250, ms));
    }

    private onTick(symbol: string) {
        const feed = hub.feed(symbol);
        if (!feed || !Number.isFinite(Number(feed.last))) return;
        this.activeTrades.forEach(trade => {
            if (trade.underlying !== symbol) return;
            const path = [...(trade.paper_price_path || []), Number(feed.last)].slice(-1000);
            const tickCount = Number(trade.paper_tick_count || 0) + 1;
            const updated = {
                ...trade,
                bid_price: round(Number(trade.buy_price), trade.currency),
                profit: 0,
                paper_price_path: path,
                paper_tick_count: tickCount,
                pip_size: Number(feed.pip) || trade.pip_size || 2,
            };
            this.activeTrades.set(trade.contract_id, updated);
            this.updateLedgerTrade(updated);
            this.publish(updated);
            if (updated.paper_target_ticks && tickCount >= updated.paper_target_ticks) {
                const won = isWinningContract(updated, Number(feed.last));
                this.settle(updated.contract_id, won ? updated.payout : 0, Number(feed.last), true);
            }
        });
    }

    private settle(id: number, sellPrice: number, exitSpot: number, expired: boolean): PaperCloseResult {
        const trade = this.activeTrades.get(Number(id));
        if (!trade) return { ok: false, error: 'Paper position not found or already closed.' };

        const roundedSell = round(Math.max(0, sellPrice), trade.currency);
        const profit = round(roundedSell - trade.buy_price, trade.currency);
        const closed = {
            ...trade,
            bid_price: roundedSell,
            sell_price: roundedSell,
            profit,
            exit_spot: exitSpot,
            exit_tick: exitSpot,
            date_expiry: Math.floor(Date.now() / 1000),
            is_sold: 1,
            is_expired: expired ? 1 : 0,
            is_valid_to_sell: 0,
            transaction_ids: {
                ...trade.transaction_ids,
                sell: `PAPER-SELL-${Math.abs(Number(id))}`,
            },
        };

        const ledger = this.getLedger(trade.accountID, trade.currency);
        const next = {
            balance: round(ledger.balance + roundedSell, trade.currency),
            trades: ledger.trades.map(item => item.contract_id === Number(id) ? closed : item),
        };
        if (!this.persist(trade.accountID, trade.currency, next)) {
            return { ok: false, error: 'Could not save the paper settlement locally.' };
        }

        this.activeTrades.delete(Number(id));
        this.publish(closed);
        if (trade.paper_source !== 'bot') {
            eventBus.emit('contract.status', { id: 'contract.sold', data: closed.transaction_ids.sell, contract: closed });
            eventBus.emit('ui.log.success', {
                log_type: profit > 0 ? LogTypes.PROFIT : LogTypes.LOST,
                extra: { currency: trade.currency, profit },
            });
        }
        this.settleResolvers.get(Number(id))?.({ contract_id: Number(id), profit, won: profit > 0 });
        this.settleResolvers.delete(Number(id));
        return { ok: true, trade: closed };
    }

    private updateLedgerTrade(trade: any) {
        const ledger = this.getLedger(trade.accountID, trade.currency);
        const next = {
            ...ledger,
            trades: ledger.trades.map(item => item.contract_id === trade.contract_id ? trade : item),
        };
        this.persist(trade.accountID, trade.currency, next);
    }

    private publish(trade: any) {
        eventBus.emit('paper.position', trade);
        eventBus.emit('bot.contract', trade);
        if (trade.paper_source === 'bot') eventBus.emit('paper.contract', trade);
    }
}

export const paperTrading = new PaperTradingStore();
