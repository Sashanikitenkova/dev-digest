# Frontend Architecture — Examples

Good/bad patterns for each rule in [SKILL.md](SKILL.md). Sources for the
underlying rules are in [README.md](README.md#references).

---

## Type-Based vs. Feature-Based Structure

```
BAD — type-based (mirrors the framework, not the domain)
src/
├── components/
│   ├── CheckoutForm.tsx
│   ├── CartSummary.tsx
│   ├── InboxList.tsx
│   └── InboxItem.tsx
├── hooks/
│   ├── useCheckout.ts
│   └── useInbox.ts
└── utils/
    ├── checkoutTotals.ts
    └── inboxFilters.ts
```

```
GOOD — feature-based (screams the domain)
src/
├── features/
│   ├── checkout/
│   │   ├── components/
│   │   │   ├── CheckoutForm.tsx
│   │   │   └── CartSummary.tsx
│   │   ├── hooks/
│   │   │   └── useCheckout.ts
│   │   └── utils/
│   │       └── checkoutTotals.ts
│   └── inbox/
│       ├── components/
│       │   ├── InboxList.tsx
│       │   └── InboxItem.tsx
│       ├── hooks/
│       │   └── useInbox.ts
│       └── utils/
│           └── inboxFilters.ts
├── components/        # only things used by 2+ features
├── hooks/              # only things used by 2+ features
└── lib/
```

---

## Feature Folder Anatomy (bulletproof-react model)

```
features/checkout/
├── api/           # service/adapter functions for this feature's requests
│   └── submit-order.ts
├── components/     # components used only within this feature
│   ├── CheckoutForm.tsx
│   └── CheckoutForm.test.tsx
├── hooks/          # this feature's custom hooks
│   └── use-checkout.ts
├── stores/         # this feature's state slice, if it needs one
│   └── checkout-slice.ts
├── types/          # this feature's local types
│   └── index.ts
└── utils/          # pure helpers used only within this feature
    └── checkout-totals.ts
```

Only add the subfolders a feature actually needs — a small feature might
just be `components/` + `hooks/`.

---

## Util vs. Helper vs. Service vs. Hook

Same logic — "compute the discounted total for a cart" — implemented four
ways:

```ts
// UTIL — pure, stateless, no React, no I/O
// utils/checkout-totals.ts
export function calculateDiscountedTotal(items: CartItem[], discountPct: number): number {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return subtotal * (1 - discountPct / 100);
}
```

```ts
// SERVICE — business logic + I/O, still no React, testable via DI
// services/pricing-service.ts
export function createPricingService(api: ApiClient) {
  return {
    async getDiscountForUser(userId: string) {
      return api.get(`/users/${userId}/discount`);
    },
  };
}
```

```ts
// CUSTOM HOOK — wraps the service, adds React state/lifecycle
// hooks/use-cart-total.ts
export function useCartTotal(items: CartItem[]) {
  const { data: discountPct = 0 } = useQuery({
    queryKey: ['discount', currentUserId],
    queryFn: () => pricingService.getDiscountForUser(currentUserId),
  });
  return calculateDiscountedTotal(items, discountPct);
}
```

```tsx
// BAD — business logic inlined in the component body
function CartSummary({ items }: { items: CartItem[] }) {
  const [discountPct, setDiscountPct] = useState(0);
  useEffect(() => {
    fetch(`/api/users/${currentUserId}/discount`)
      .then(r => r.json())
      .then(d => setDiscountPct(d.value));
  }, []);
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const total = subtotal * (1 - discountPct / 100);
  return <p>{total}</p>;
}

// GOOD — component only renders
function CartSummary({ items }: { items: CartItem[] }) {
  const total = useCartTotal(items);
  return <p>{total}</p>;
}
```

---

## Barrel Files

```ts
// BAD — internal app barrel, forces every module in features/inbox to
// load synchronously just to import one component
// features/inbox/index.ts
export * from './components/InboxList';
export * from './components/InboxItem';
export * from './hooks/use-inbox';
export * from './utils/inbox-filters';

// consumer
import { InboxList } from '@/features/inbox'; // pulls in hooks + utils too
```

```ts
// GOOD — import directly from the file that defines what you need
import { InboxList } from '@/features/inbox/components/InboxList';
```

```ts
// GOOD — barrel is fine at a published package's public boundary
// src/vendor/ui/index.ts (this repo's vendored @devdigest/ui)
export * from './Button';
export * from './Card';
// intentional: this IS the package's public API surface
```

---

## Next.js App Router: Colocation, Private Folders, Route Groups

```
app/
├── (marketing)/            # route group — organizes without affecting the URL
│   ├── page.tsx             # "/"
│   └── about/
│       └── page.tsx         # "/about"
├── (app)/                   # route group for the authenticated app section
│   └── dashboard/
│       ├── page.tsx         # "/dashboard"
│       ├── _components/     # private folder — route-local, not routable
│       │   └── UsageChart.tsx
│       └── _lib/
│           └── format-usage.ts
└── layout.tsx

src/
├── components/               # shared across routes/features
│   └── app-shell/
├── hooks/                     # shared across routes/features
└── lib/
    └── api.ts
```

- `(marketing)` and `(app)` don't appear in the URL — they only group routes.
- `_components` and `_lib` are guaranteed non-routable, signaling "route-local implementation detail" even though plain colocation (without the underscore) would already be safe.
- Anything reused by more than one route/feature moves out to `src/components`, `src/hooks`, `src/lib`.
