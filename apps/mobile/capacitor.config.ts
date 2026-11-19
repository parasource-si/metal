import type { CapacitorConfig } from "@capacitor/cli";
import type { KeyboardResize } from "@capacitor/keyboard";

const config: CapacitorConfig = {
  appId: "bot.dusk.mobile",
  appName: "Metal",
  webDir: "dist",
  // the native bridge logs plugin results in debug builds, which would put pairing secrets and tokens in device logs
  loggingBehavior: "none",
  // dev only: live reload from the local vite server
  ...(process.env.DUSK_MOBILE_DEV_URL ? { server: { url: process.env.DUSK_MOBILE_DEV_URL, cleartext: true } } : {}),
  ios: { contentInset: "never", scrollEnabled: false, backgroundColor: "#fcfcfc", allowsLinkPreview: false },
  android: { backgroundColor: "#fcfcfc", allowMixedContent: false },
  plugins: {
    Keyboard: { resize: "none" as KeyboardResize, resizeOnFullScreen: false },
    SplashScreen: { launchShowDuration: 0, launchAutoHide: true },
    StatusBar: { overlaysWebView: true, style: "DEFAULT" },
    // on Android the window's insets and the keyboard's are the app's own (android/.../InsetsPlugin.java)
    SystemBars: { insetsHandling: "disable" },
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
    CapacitorHttp: { enabled: true },
  },
};

export default config;
