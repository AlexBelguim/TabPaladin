// Firefox/Chrome compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
if (typeof chrome === 'undefined' || !chrome.storage) { globalThis.chrome = browserAPI; }

/**
 * TabGrouper - Handles logic for grouping tabs and bookmarks based on domain and context.
 */

// Heuristic Keywords Configuration
// Note: Shorter keywords should be used carefully or matched with boundaries.
const CONTEXT_KEYWORDS = {
    "Gaming": ["gaming", "game", "minecraft", "league of legends", "csgo", "steam", "twitch", "discord", "gameplay", "walkthrough"],
    "Adult": ['nhentai', 'jav', 'porn', 'hentai', 'sex', 'xxx', 'adult', '18+', 'erotic', 'leaks', 'onlyfans', 'fansly'],
    "AI & Tech": ['comfyui', 'stable diffusion', 'diffusion', 'artificial intelligence', 'llm', 'lora', 'civitai', 'huggingface', 'tensor', 'neural', 'gpt', 'openai'],
    "Coding": ["github", "stackoverflow", "mdn", "w3schools", "dev", "programming", "code", "script"],
    "Video": ["youtube", "vimeo", "netflix", "hulu", "watch"],
    "Social": ["twitter", "x.com", "facebook", "instagram", "patreon", "linkedin", "reddit"],
    "News": ["news", "cnn", "bbc", "nytimes", "weather"],
    "Shopping": ["amazon", "ebay", "shopify", "store", "shop"]
};

// Synonyms for folder matching (Context -> Possible Folder Names)
export const CONTEXT_SYNONYMS = {
    "Adult": ["Porn", "XXX", "NSFW", "Hentai", "18+"],
    "Gaming": ["Games", "Video Games", "Steam"],
    "Coding": ["Dev", "Development", "Programming"],
    "Video": ["Videos", "Movies", "Streaming"],
    "Social": ["Social Media"],
    "AI & Tech": ["AI", "Tech", "Artificial Intelligence"]
};

// Helper: Extract domain from URL
function getDomain(url) {
    try {
        const hostname = new URL(url).hostname;
        // Simple Heuristic: Remove www.
        // If we have multiple dots (discuss.example.com), take the part before the TLD?
        // It's hard to know TLD without a list.
        // Let's assume standard 2-part (example.com) or 3-part (sub.example.com).
        // If we have > 2 parts, and the last part is > 2 chars (com, net, org), take the second to last.
        // If last part is 2 chars (uk, jp), it might be co.uk.
        // Let's stick to a robust simple version: Use the *longest* meaningful word? 
        // No, let's use the standard "Limit to 2 segments if possible" approach.

        const parts = hostname.split('.');
        if (parts.length > 2) {
            // Check for common short TLDs/SLDs??
            // Safe bet: return the full hostname minus 'www' logic? 
            // User wants "EroScripts" from "discuss.eroscripts.com".
            // That is parts[parts.length - 2].
            // Exception: "google.co.uk" -> "co" -> BAD.
            // Heuristic: If second-to-last length < 3, take third-to-last?

            const secondLast = parts[parts.length - 2];
            if (secondLast.length <= 3 && parts.length > 3) {
                return parts[parts.length - 3];
            }
            return secondLast;
        }
        return parts[0]; // example.com -> example
    } catch (e) {
        return 'unknown';
    }
}

// Helper: Determine context based on title and URL
// Now accepts merged keywords
function getContext(item, keywordMap = CONTEXT_KEYWORDS) {
    const text = (item.title + " " + item.url).toLowerCase();

    for (const [context, keywords] of Object.entries(keywordMap)) {
        // Use word boundary check for short keywords (< 4 chars) to avoid "ai" matching "mail"
        const match = keywords.some(keyword => {
            if (keyword.length < 4) {
                // Regex boundary check
                const regex = new RegExp(`\\b${keyword}\\b`, 'i');
                return regex.test(text);
            }
            return text.includes(keyword);
        });

        if (match) {
            return context;
        }
    }
    return "Other";
}

export const TabGrouper = {
    /**
     * Groups items (tabs or flatted bookmarks) by their Domain.
     * @param {Array} items - Array of tab/bookmark objects.
     * @returns {Object} Grouped items: { "youtube.com": [item1, item2], ... }
     */
    groupByDomain: (items) => {
        return items.reduce((groups, item) => {
            const domain = getDomain(item.url);
            if (!groups[domain]) {
                groups[domain] = [];
            }
            groups[domain].push(item);
            return groups;
        }, {});
    },

    /**
     * Groups items by Context (Heuristic/AI).
     * @param {Array} items - Array of items.
     * @param {Object} customKeywords - Optional map of { Category: [kw1, kw2] } to merge.
     */
    groupByContext: (items, customKeywords = {}) => {
        // Merge Logic: Clone default, then push custom
        // We do a shallow merge of arrays
        const mergedMap = { ...CONTEXT_KEYWORDS };

        for (const [cat, kws] of Object.entries(customKeywords)) {
            if (mergedMap[cat]) {
                // De-dupe and merge
                mergedMap[cat] = [...new Set([...mergedMap[cat], ...kws])];
            } else {
                mergedMap[cat] = kws;
            }
        }

        return items.reduce((groups, item) => {
            const context = getContext(item, mergedMap);
            if (!groups[context]) {
                groups[context] = [];
            }
            groups[context].push(item);
            return groups;
        }, {});
    },

    /**
     * Smart Grouping: Tries context first, then domain for "Other", or keeps "Other".
     * This is the main function the UI will likely use.
     */
    groupSmart: (items) => {
        const byContext = TabGrouper.groupByContext(items);

        // Optional: If "Other" is too large, break it down by domain?
        // For now, let's just return the context grouping as the primary "Smart" view.
        return byContext;
    },

    CONTEXT_SYNONYMS: CONTEXT_SYNONYMS
};
