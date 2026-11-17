import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { getCurrencyDisplayCode, getDecimalPlaces } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import { paperTrading } from './paper-trading';
import './paper-mode-controls.scss';

export const PaperModeControls = observer(() => {
    const { client } = useStore() ?? {};
    const loginid = client?.loginid || '';
    const currency = client?.currency || 'USD';
    const active = paperTrading.isActive(loginid);
    const balance = active ? paperTrading.balanceFor(loginid, currency) : null;
    const [isOpen, setIsOpen] = useState(false);
    const [amount, setAmount] = useState('');
    const [error, setError] = useState('');
    const typed = useRef('');
    const lastKeyAt = useRef(0);
    const tapTimes = useRef<number[]>([]);

    const openModal = useCallback(() => {
        setAmount(String(balance ?? ''));
        setError('');
        setIsOpen(true);
    }, [balance]);

    useEffect(() => {
        if (!active) {
            setIsOpen(false);
            typed.current = '';
            tapTimes.current = [];
            return;
        }
        paperTrading.resume(loginid, currency);
    }, [active, loginid, currency]);

    useEffect(() => {
        if (!active || !window.matchMedia('(pointer: fine)').matches) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsOpen(false);
            if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
            if (
                event.target instanceof Element &&
                event.target.closest('input, textarea, select, [contenteditable="true"]')
            ) {
                typed.current = '';
                return;
            }

            const now = Date.now();
            if (now - lastKeyAt.current > 2500) typed.current = '';
            lastKeyAt.current = now;
            typed.current = `${typed.current}${event.key.toLowerCase()}`.slice(-5);
            if (typed.current === 'reset') {
                typed.current = '';
                openModal();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [active, openModal]);

    useEffect(() => {
        if (!active) return;
        const logo = document.querySelector('.app-header__logo');
        if (!logo) return;
        const onLogoTap = (event: Event) => {
            const isTouch = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
            if (!isTouch) return;
            // Keep the five-tap sequence on the current page instead of following the logo's home link.
            event.preventDefault();
            const now = Date.now();
            tapTimes.current = [...tapTimes.current.filter(time => now - time <= 2000), now];
            if (tapTimes.current.length >= 5) {
                tapTimes.current = [];
                openModal();
            }
        };
        logo.addEventListener('click', onLogoTap);
        return () => logo.removeEventListener('click', onLogoTap);
    }, [active, openModal]);

    const save = (event: React.FormEvent) => {
        event.preventDefault();
        if (!amount.trim()) {
            setError('Enter a balance.');
            return;
        }
        const result = paperTrading.setBalance(loginid, currency, amount);
        if (!result.ok) {
            setError(result.error || 'Could not save the paper balance.');
            return;
        }
        setIsOpen(false);
    };

    if (!active) return null;
    const formattedBalance = Number(balance || 0).toFixed(getDecimalPlaces(currency));

    return (
        <>
            <div
                className='nx-paper-balance'
                aria-label='Local paper-trading balance'
                title='Trade results are simulated locally and may differ from live Deriv contracts.'
            >
                <span className='nx-paper-balance__label'>LOCAL PAPER</span>
                <strong>{formattedBalance} {getCurrencyDisplayCode(currency)}</strong>
            </div>
            {isOpen && (
                <div className='nx-paper-modal' role='presentation' onMouseDown={event => {
                    if (event.target === event.currentTarget) setIsOpen(false);
                }}>
                    <section className='nx-paper-modal__card' role='dialog' aria-modal='true' aria-labelledby='nx-paper-title'>
                        <h2 id='nx-paper-title'>Update paper balance</h2>
                        <p>
                            This simulated balance is saved only in this browser; your Deriv balance is unchanged.
                            Trade outcomes and early-close values are local estimates and may differ from live Deriv contracts.
                        </p>
                        <form onSubmit={save}>
                            <label htmlFor='nx-paper-amount'>New paper balance ({getCurrencyDisplayCode(currency)})</label>
                            <input
                                id='nx-paper-amount'
                                type='number'
                                min='0'
                                step='any'
                                autoFocus
                                value={amount}
                                onChange={event => setAmount(event.target.value)}
                            />
                            {error && <div className='nx-paper-modal__error' role='alert'>{error}</div>}
                            <div className='nx-paper-modal__actions'>
                                <button type='submit'>Save / Update</button>
                                <button type='button' onClick={() => setIsOpen(false)}>Cancel</button>
                            </div>
                        </form>
                    </section>
                </div>
            )}
        </>
    );
});
