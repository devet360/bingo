# Verity mobile scanner

This Flutter package implements camera/gallery receipt capture and on-device OCR for Android and iOS. It extracts editable provider, transaction reference, amount, currency, and date candidates. It never uploads the image or treats OCR text as a verified payment.

## Platform setup

- The Flutter SDK and Android/iOS toolchains are required to build this app. The current agent workspace has neither installed, so these native targets have not been compiled here.
- Android: use the Flutter-generated Android project with `minSdkVersion` 23 or higher for current secure platform support. Add camera permission and a user-facing camera rationale to `android/app/src/main/AndroidManifest.xml`.
- iOS: use a Flutter-generated Runner target with iOS deployment target 15 or higher. Add `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` to `ios/Runner/Info.plist`, and add the `LatinOCRResources.bundle` required by the current ML Kit plugin release to the Runner target's Copy Bundle Resources phase.
- `google_mlkit_text_recognition` supports native Android/iOS only. The app currently uses the Latin script; iOS does not support the plugin's optional non-Latin recognizers.

## Run and test

From this directory, run `flutter pub get`, `flutter analyze`, and `flutter test`, then build separately with `flutter build apk` or `flutter build ios`. No customer API key is embedded in the app. API authentication and account synchronization require the platform's user-session endpoints to be completed before enabling remote account features.
