---
description: Add a new page/route to SoDEX Terminal
---

## Steps to add a new page

1. Create the page component at `src/pages/MyPage.tsx`
   - Export a named export matching the filename: `export const MyPage: React.FC = () => { ... }`
   - Use `Card`/`StatCard` from `components/common/Card` for layout
   - Import `cn` from `../lib/utils`

2. Register the lazy import in `src/App.tsx`
   ```tsx
   const MyPage = lazyFrom(() => import('./pages/MyPage').then(m => ({ default: m.MyPage })), 'MyPage');
   ```

3. Add the `<Route>` inside the `<Suspense>` block in `App.tsx`
   ```tsx
   <Route path="/my-page" element={<MyPage />} />
   ```

4. Add a nav item to the appropriate section in `src/components/Sidebar.tsx`
   ```tsx
   { to: '/my-page', icon: SomeIcon, label: 'My Page' }
   ```

5. Import the icon from `lucide-react` at the top of `Sidebar.tsx`
