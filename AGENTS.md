# Smart Ombor — agent qoidalari

**Default = MUZLATILGAN.** Foydalanuvchi aniq ruxsat bermaguncha kod yozilmaydi / o‘zgartirilmaydi.

Batafsil: `.cursor/rules/smart-ombor-locked.mdc`

- Tayyor bo‘limlar (Mahsulotlar, Skaner, Hamkor, Stock, Hisobotlar, UI kit, …) buzilmasin.
- Hozirgi ish: faqat so‘ralgan **KPI / GPS / Davomat**.
- `App.tsx`, `access.ts`, `i18n.tsx`, `local-auth.ts` — eng qattiq lock.
- Collateral refactor taqiqlangan.
