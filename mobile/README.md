# Trawsgrifiwr Byw Android / Live Transcriber Android

**[English version below](#english) | [Fersiwn Gymraeg isod](#cymraeg)**

---

<a name="cymraeg"></a>
## 🏴󠁧󠁢󠁷󠁬󠁳󠁿 Cymraeg

Rhaglen Android ar gyfer adnabod lleferydd Cymraeg amser real, 100% all-lein, gan ddefnyddio model Kaldi/Vosk o Brifysgol Bangor.

Fersiwn Android o brosiect bwrdd gwaith [Trawsgrifiwr Byw](https://github.com/techiaith/trawsgrifiwr-byw).

### ✨ Nodweddion

- 🎤 **Adnabod Lleferydd Amser Real** - Gweld trawsgrifiadau byw wrth i chi siarad.
- ⚡ **Cyfieithu Byw ar y Ddyfais** - Cyfieithu Cymraeg i'r Saesneg amser real yn syth o dan bob brawddeg (Google ML Kit ar-ddyfais all-lein gyda chwymp-yn-ôl i API Techiaith).
- 💾 **Hanes Sesiynau a Chadw Lleol** - Yn cadw trawsgrifiadau a chyfieithiadau mewn sesiynau ar wahân ar gof y ffôn; gallwch ddechrau sesiwn newydd neu adfer hen sesiynau ar unrhyw adeg.
- 🌙 **Modd Tywyll / Dark Mode** - Cefnogaeth lawn i themâu golau a thywyll.
- 📴 **100% All-lein** - Dim angen cysylltiad rhyngrwyd ar gyfer adnabod lleferydd a chyfieithu ar-ddyfais; mae eich llais a'ch data yn aros ar eich dyfais.
- 🏴󠁧󠁢󠁷󠁬󠁳󠁿 **Model Iaith Gymraeg Kaldi** - Yn defnyddio modelau Prifysgol Bangor (`techiaith/kaldi-cy`).
- 📱 **Android** - Cefnogaeth i ffonau a thabledi Android.
- ⏱️ **Stampiau Amser** - Brawddegau cyflawn wedi'u trefnu gyda stamp amser `[HH:mm:ss]`.
- 📋 **Copïo Hawdd** - Copïo gyda stampiau amser neu destun parhaus yn unig.
- 📤 **Rhannu Symudol Brodorol** - Anfon trawsgrifiadau'n uniongyrchol i WhatsApp, Negeseuon, E-bost neu Nodiadau.
- 🔍 **Maint Ffont Hygyrch** - Newid maint y testun (A- / A+) er hwylustod darllen.
- ℹ️ **Gwybodaeth a Thrwyddedau** - Moddol gwybodaeth a thrwyddedau integredig (MIT Bangor a Vosk Apache 2.0).
- 🌐 **Rhyngwyneb Dwyieithog** - Togl rhwng Cymraeg, Saesneg, neu Ddwyieithog.

### 🚀 Cychwyn Cyflym

#### 1. Gosod Dibyniaethau
```bash
npm install
```

#### 2. Lawrlwytho'r Model Cymraeg
Mae angen model iaith Vosk/Kaldi (~115MB wedi'i gywasgu, ~270MB wedi'i ddatgywasgu):
```bash
./download-model.sh
```

#### 3. Rhedeg ar Ddyfais neu Efelychydd Android
```bash
# Cychwyn gweinydd datblygu Metro
npm start

# Rhedeg ar Android
npm run android
```

---

<a name="english"></a>
## 🇬🇧 English

An Android mobile application for real-time, 100% offline Welsh speech recognition using the Bangor University Kaldi/Vosk model.

Android edition of the desktop [Trawsgrifiwr Byw](https://github.com/techiaith/trawsgrifiwr-byw).

### ✨ Features

- 🎤 **Real-time Speech Recognition** - See partial live Welsh transcriptions stream as you speak.
- ⚡ **On-Device Live Translation** - Real-time Welsh-to-English translation directly beneath each sentence (powered on-device by Google ML Kit offline inference, with Bangor Techiaith API fallback).
- 💾 **Discrete Session History & Local Storage** - Automatically saves transcriptions and translations into discrete sessions on-device; start a fresh session on launch or resume any past session at any time.
- 🌙 **Dark Mode** - Full light and dark theme support with smooth status bar integration.
- 📴 **100% Offline** - Zero internet required after setup; speech and transcription remain completely private on-device.
- 🏴󠁧󠁢󠁷󠁬󠁳󠁿 **Welsh Kaldi Model** - Powered by Bangor University Language Technologies Unit (`techiaith/kaldi-cy`).
- 📱 **Android Native** - Native support for Android phones and tablets.
- ⏱️ **Timestamped Utterances** - Completed sentences formatted with `[HH:mm:ss]` timestamps.
- 📋 **One-tap Copying** - Copy with timestamps or as plain continuous text.
- 📤 **Native Mobile Sharing** - Share directly to WhatsApp, SMS, Email, or Notes via the native share sheet.
- 🔍 **Accessible Text Sizing** - Quick font-size controls (A- / A+) for readability.
- ℹ️ **Credits & Licences** - Built-in attribution modal displaying Bangor University MIT and Vosk Apache 2.0 notices.
- 🌐 **Bilingual Interface** - Instant toggle between Welsh, English, or Bilingual views.

### 🛠️ Architecture & Technologies

- **React Native 0.83 & Expo (SDK 55)** - Mobile foundation.
- **`react-native-vosk`** - Native offline speech recognition engine binding via `libvosk.so` (`com.alphacephei:vosk-android`) + `AudioRecord`.
- **Kaldi Welsh Model (`techiaith/kaldi-cy`)** - Low-latency offline LF-MMI acoustic model packaged for Vosk.
- **`@react-native-ml-kit/translate-text`** - On-device neural translation engine.

### 📦 Building for Production

#### Android (APK / AAB)
```bash
# Generate native Android project with pre-configured permissions and model assets
npx expo prebuild --platform android

# Build debug APK
cd android && ./gradlew assembleDebug

# Build standalone release APK
cd android && ./gradlew assembleRelease

# Or build release AAB for Google Play Store
cd android && ./gradlew bundleRelease
```

---

### 📄 Trwydded / License

Trwydded MIT / MIT License — gweler [LICENSE](LICENSE).
- **Ap Symudol Android / Android Mobile App:** © 2026 Sean (S34NW)
- **Trawsgrifiwr Byw Bwrdd Gwaith Gwreiddiol / Original Desktop Application:** © 2025 Prifysgol Bangor University
- **Modelau Lleferydd Cymraeg / Welsh Speech Models:** © Uned Technolegau Iaith, Prifysgol Bangor (Apache 2.0 / CC-BY-SA).
