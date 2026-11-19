# Bordo Agent GPS (fon kuzatuv)

Android ilova — agent kabineti yopiq / app background da bo‘lsa ham ish soatida GPS yuboradi.

API: `POST https://bordoombor.uz/api/kpi/agent/location` (`source: native`)

## Talablar (APK yig‘ish)

- Node.js 20+
- **JDK 21** (`JAVA_HOME`) — Capacitor 7 pluginlar uchun (JDK 25 Android Studio JBR ishlamaydi)
- Android SDK (`ANDROID_HOME` yoki `%LOCALAPPDATA%\Android\Sdk`)
- Android Studio (tavsiya) yoki command-line Gradle

```powershell
# misol: Zulu / Temurin 21
$env:JAVA_HOME = "$env:USERPROFILE\.jdks\jdk-21"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

## O‘rnatish va build

```powershell
cd artifacts/agent-tracker
npm install
node node_modules/esbuild/install.js   # kerak bo‘lsa
npm run build
npx cap sync android
```

### Android Studio orqali

```powershell
npx cap open android
```

`Build → Build Bundle(s) / APK(s) → Build APK(s)`.

APK yo‘li: `android/app/build/outputs/apk/debug/app-debug.apk`

### CLI (Gradle)

```powershell
cd android
.\gradlew.bat assembleDebug
```

Release uchun keystore bilan `assembleRelease`.

## Agentlarga o‘rnatish

1. APK yuklab olish: [https://bordoombor.uz/agent-tracker.apk](https://bordoombor.uz/agent-tracker.apk) (yoki Telegram orqali).
2. Telefon: **Noma’lum manbalardan o‘rnatish** ga ruxsat.
3. Ilovani oching → agent **login/parol** → **Kuzatuvni yoqish**.
4. Joylashuv ruxsati: **Har doim ruxsat** (Allow all the time).
5. Bildirishnoma ruxsatini bering (foreground service).

### Xiaomi / Huawei / Oppo

- Sozlamalar → Ilovalar → Bordo Agent GPS → **Avtoyuklash** yoqing.
- Batareya → **Cheklanmagan** / fon faoliyatiga ruxsat.
- Force stop qilmang — aks holda fon GPS to‘xtaydi.

## Ish soati

Toshkent `06:00–18:00` (Dushanba dam, Se–Ya ish). Shu oralig‘ida ping yuboriladi.

## VPS ga API + admin

`native` source va «Fon GPS» label uchun API/UI deploy qiling:

- `artifacts/api-server/src/routes/kpi.ts`
- `artifacts/api-server/src/lib/kpi/work-hours.ts`
- `artifacts/smart-ombor/src/kpi/gps.tsx`

Keyin VPS da `pnpm run build` (api + smart-ombor) va `systemctl restart smart-ombor`.

APK ni static sifatida qo‘yish (ixtiyoriy):

```bash
# VPS
mkdir -p /opt/smart-ombor/artifacts/smart-ombor/dist
# yoki nginx root ga:
cp app-debug.apk /var/www/bordoombor/agent-tracker.apk
```

## Dev (brauzer)

```powershell
npm run dev
```

Brauzerda fon GPS ishlamaydi — faqat ochiq tabda. Haqiqiy fon uchun APK kerak.

## Env

`VITE_API_BASE` — default `https://bordoombor.uz`
