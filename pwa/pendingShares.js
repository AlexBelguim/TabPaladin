// Shares that could not be delivered, kept on the phone until they can be.
//
// A share arrives as a navigation, and once the app cleans its URL it is gone.
// So a delivery that fails — signed out, the session revoked by a password
// reset, the server unreachable — must not drop it. Each queued share
// remembers which account was signed in when it was made. After the next
// sign-in, that account's shares are delivered on their own; anyone else's,
// or ones made while nobody was signed in, are offered first, because they may
// not be this account's to receive.
//
// No DOM in here, so tools/test_share_sw.mjs can drive it with a fake storage.

export const PENDING_SHARES_KEY = 'tp_pending_shares';
const MAX_PENDING = 200;

const sameShare = (a, b) => a.url === b.url && a.at === b.at;

export function makePendingShares({ storage, key = PENDING_SHARES_KEY }) {
    const read = () => {
        try {
            const list = JSON.parse(storage.getItem(key));
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    };
    const write = (list) => {
        if (list.length) storage.setItem(key, JSON.stringify(list.slice(-MAX_PENDING)));
        else storage.removeItem(key);
    };

    const pending = {
        list: read,

        queue({ url, title = '', at = new Date().toISOString(), userId = null }) {
            const list = read();
            list.push({ url, title, at, userId: userId === undefined ? null : userId });
            write(list);
        },

        // A share as it arrives: delivered now when possible, queued — before
        // the caller cleans the URL — whenever it is not. Never both, never
        // neither. Returns {delivered, queued, result, error}: `error` is why
        // a delivery that was tried failed, so the caller can say so.
        async take(share, { canDeliver, deliver }) {
            let error = null;
            if (canDeliver) {
                try {
                    return { delivered: true, queued: false, result: await deliver(share), error };
                } catch (e) {
                    // Falls through to the queue.
                    error = e;
                }
            }
            pending.queue(share);
            return { delivered: false, queued: true, result: null, error };
        },

        // Deliver what is queued, for the account now signed in (`userId`).
        // `deliver(share)` throws on failure, and a failed share stays queued.
        // `ask(shares)` is asked about everyone else's and answers 'add',
        // 'discard' or 'keep'. Returns {added, discarded, kept}.
        async drain({ userId, deliver, ask }) {
            const list = read();
            if (!list.length) return { added: 0, discarded: 0, kept: 0 };
            const mine = list.filter(s => userId !== null && userId !== undefined && s.userId === userId);
            const others = list.filter(s => !mine.includes(s));
            const keep = [];
            let added = 0;
            let discarded = 0;
            const send = async (s) => {
                try { await deliver(s); added++; } catch (e) { keep.push(s); }
            };
            for (const s of mine) await send(s);
            if (others.length) {
                const answer = await ask(others);
                if (answer === 'add') {
                    for (const s of others) await send(s);
                } else if (answer === 'discard') {
                    discarded = others.length;
                } else {
                    keep.push(...others);
                }
            }
            // Anything queued while this ran is kept too.
            const arrived = read().filter(s => !list.some(o => sameShare(o, s)));
            write([...keep, ...arrived]);
            return { added, discarded, kept: keep.length + arrived.length };
        }
    };
    return pending;
}
