import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Newspaper, RefreshCw, ExternalLink, Search } from 'lucide-react';
import {
  fetchSosoCoins,
  fetchSosoNews,
  fetchSosoNewsByCurrency,
  NEWS_CATEGORIES,
  getNewsTitle,
} from '../api/sosoServices';
import type { SosoCoin, SosoNewsItem } from '../api/sosoServices';
import { useSettingsStore } from '../store/settingsStore';
import { clearSosoCache } from '../api/sosoValueClient';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { cn } from '../lib/utils';
import toast from 'react-hot-toast';

const ALL_CATS = [1, 2, 3, 4, 5, 6, 7, 9, 10];

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const CryptoNews: React.FC = () => {
  const { sosoApiKey } = useSettingsStore();
  const [coins, setCoins] = useState<SosoCoin[]>([]);
  const [news, setNews] = useState<SosoNewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [selectedCoin, setSelectedCoin] = useState<SosoCoin | null>(null);
  const [selectedCats, setSelectedCats] = useState<number[]>(ALL_CATS);
  const [searchQuery, setSearchQuery] = useState('');

  // Load coin list once on mount / API key change
  useEffect(() => {
    if (!sosoApiKey) return;
    fetchSosoCoins()
      .then((list) => setCoins(list.slice(0, 20)))
      .catch(() => {});
  }, [sosoApiKey]);

  const loadNews = useCallback(async (p = 1, replace = true) => {
    if (!sosoApiKey) {
      toast.error('Set your SosoValue API key in Settings first.');
      return;
    }
    if (replace) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const cats = selectedCats.length > 0 ? selectedCats : ALL_CATS;
      const result = selectedCoin
        ? await fetchSosoNewsByCurrency(selectedCoin.id, p, 5, cats)
        : await fetchSosoNews(p, 5, cats);

      const items = result.list ?? [];
      setNews((prev) => replace ? items : [...prev, ...items]);
      setPage(result.page || p);
      setHasMore(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load news';
      toast.error(msg);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [sosoApiKey, selectedCoin, selectedCats]);

  const initialLoadDone = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load + reload when API key / coin / category changes
  useEffect(() => {
    if (!sosoApiKey) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      loadNews(1, true);
    } else {
      debounceRef.current = setTimeout(() => {
        loadNews(1, true);
      }, 700);
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sosoApiKey, selectedCoin, selectedCats]);

  const toggleCat = (cat: number) => {
    setSelectedCats((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  };

  const filtered = news.filter((item) => {
    if (!searchQuery) return true;
    const title = getNewsTitle(item).toLowerCase();
    return title.includes(searchQuery.toLowerCase());
  });

  const isNoKey = !sosoApiKey;

  return (
    <div className="flex h-[calc(100vh-52px)] overflow-hidden">
      {/* Side filter panel */}
      <aside className="w-56 shrink-0 border-r border-border overflow-y-auto p-4 space-y-5">
        {/* Coin Filter */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-2">Coin</p>
          <button
            onClick={() => setSelectedCoin(null)}
            className={cn(
              'w-full text-left px-3 py-1.5 rounded-lg text-xs mb-1 transition-all',
              !selectedCoin ? 'bg-primary/10 text-primary font-semibold' : 'text-text-secondary hover:text-text',
            )}
          >
            All Coins
          </button>
          {coins.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCoin(c)}
              className={cn(
                'w-full text-left px-3 py-1.5 rounded-lg text-xs transition-all',
                selectedCoin?.id === c.id ? 'bg-primary/10 text-primary font-semibold' : 'text-text-secondary hover:text-text',
              )}
            >
              <span className="font-medium">{c.name.toUpperCase()}</span>
              <span className="text-text-muted ml-1 text-[10px]">{c.fullName}</span>
            </button>
          ))}
        </div>

        {/* Category filter */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-2">Category</p>
          <button
            onClick={() => setSelectedCats(ALL_CATS)}
            className="text-[10px] text-primary underline mb-2 block"
          >
            Select All
          </button>
          {ALL_CATS.map((cat) => {
            const meta = NEWS_CATEGORIES[cat];
            return (
              <button
                key={cat}
                onClick={() => toggleCat(cat)}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-1.5 rounded-lg text-xs mb-0.5 transition-all',
                  selectedCats.includes(cat) ? 'bg-surface text-text' : 'text-text-muted opacity-50',
                )}
              >
                <span className={cn('inline-block w-2 h-2 rounded-full', meta.color.split(' ')[0].replace('text-', 'bg-'))} />
                {meta.label}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {/* Top bar */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 flex-1 bg-surface border border-border rounded-xl px-3 py-2">
            <Search size={14} className="text-text-muted" />
            <input
              type="text"
              placeholder="Search headlines..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <Button
            variant="outline"
            icon={<RefreshCw size={13} />}
            onClick={() => { clearSosoCache(); loadNews(1, true); }}
            loading={loading}
          >
            Refresh
          </Button>
        </div>

        {isNoKey && (
          <div className="glass-card p-4 border border-warning/30 bg-warning/5 text-warning text-sm">
            ⚠️ No SosoValue API key set. Go to <strong>Settings → API Connection</strong> to add it.
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-16 text-text-muted text-sm">
            <RefreshCw size={16} className="animate-spin mr-2" /> Loading news...
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <Newspaper size={40} className="opacity-20 mb-3" />
            <p className="text-sm">No news found</p>
          </div>
        )}

        {/* News cards */}
        {filtered.map((item) => {
          const title = getNewsTitle(item);
          const cat = NEWS_CATEGORIES[item.category];
          return (
            <a
              key={item.id}
              href={item.sourceLink}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <Card className="hover:border-primary/40 transition-all cursor-pointer group">
                <div className="flex gap-4">
                  {item.featureImage && (
                    <img
                      src={item.featureImage}
                      alt=""
                      className="w-20 h-16 object-cover rounded-lg shrink-0 opacity-80 group-hover:opacity-100 transition-opacity"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      {cat && (
                        <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', cat.color)}>
                          {cat.label}
                        </span>
                      )}
                      {item.matchedCurrencies.slice(0, 3).map((c) => (
                        <span key={c.id} className="text-[10px] bg-surface px-2 py-0.5 rounded-full text-text-muted">
                          {c.name.toUpperCase()}
                        </span>
                      ))}
                      <span className="text-[10px] text-text-muted ml-auto">{timeAgo(item.releaseTime)}</span>
                    </div>
                    <p className="text-sm font-medium leading-snug line-clamp-2 group-hover:text-primary transition-colors">
                      {title}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] text-text-muted">{item.author}</span>
                      <ExternalLink size={10} className="text-text-muted ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </div>
                </div>
              </Card>
            </a>
          );
        })}

        {/* Load More */}
        {hasMore && !loading && news.length > 0 && (
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              onClick={() => loadNews(page + 1, false)}
              loading={loadingMore}
            >
              Load More
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
