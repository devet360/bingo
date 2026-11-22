export type BotLocale = 'en' | 'am';

export function resolveBotLocale(languageCode?: string, storedLocale?: string | null): BotLocale {
  if (storedLocale === 'am' || storedLocale === 'en') return storedLocale;
  return languageCode?.toLowerCase().startsWith('am') ? 'am' : 'en';
}

interface BotCopy {
  welcomeVerify: string;
  welcomeBack: string;
  shareContactButton: string;
  playButton: string;
  playPrompt: string;
  contactSaved: (phone: string) => string;
  contactVerified: string;
  contactButtonHint: string;
  help: string;
  notOwnContact: string;
  invalidPhone: string;
  phoneTaken: string;
  staffWelcome: string;
  staffLinked: string;
  staffLinkInvalid: string;
  dashboardAdmin: string;
  dashboardSupport: string;
  dashboardAgent: string;
  appNotConfigured: string;
  somethingWentWrong: string;
}

export const botCopy: Record<BotLocale, BotCopy> = {
  en: {
    welcomeVerify:
      'Welcome to Bingo 251! To create your player account, share your phone number using the button below. We only use it to verify you.',
    welcomeBack: 'Welcome back! Your number is verified — tap below to enter the hall.',
    shareContactButton: 'Share my number',
    playButton: 'Play Bingo',
    playPrompt: 'Tap the button below to enter the hall.',
    contactSaved: (phone) =>
      `Your number ${phone} is verified. You can now play. Winnings are credited to your in-game wallet.`,
    contactVerified: 'Your phone number is verified.',
    contactButtonHint: 'Tap “Share my number” below so we can verify you.',
    help:
      'Bingo 251 is a real-time bingo game.\n\n/start — open the game\n/verify — re-verify your phone number\n/dashboard — staff and agents: open your console\n/help — this message',
    notOwnContact: 'Please share your own number using the button, not a contact card.',
    invalidPhone: 'Telegram sent a number we could not read. Please try again.',
    phoneTaken: 'That number is already linked to another account. Contact support in the app.',
    staffWelcome: 'You are signed in as staff. Open your dashboard below.',
    staffLinked: 'Your Telegram account is linked. Open your dashboard below.',
    staffLinkInvalid: 'That staff link has expired or was already used. Ask an admin for a new one.',
    dashboardAdmin: 'Admin console',
    dashboardSupport: 'Support desk',
    dashboardAgent: 'Agent dashboard',
    appNotConfigured: 'The game link is not configured yet. Please try again later.',
    somethingWentWrong: 'Something went wrong. Please try again in a moment.',
  },
  am: {
    welcomeVerify:
      'እንኳን ወደ ቢንጎ አዳራሽ በደህና መጡ! የተጫዋች መዝገብዎን ለመክፈት ከታች ባለው አዝራር የስልክ ቁጥርዎን ያጋሩ። ቁጥሩን የምንጠቀመው ማንነትዎን ለማረጋገጥ ብቻ ነው።',
    welcomeBack: 'እንኳን ደግመው መጡ! ቁጥርዎ ተረጋግጧል — ለመግባት ከታች ይጫኑ።',
    shareContactButton: 'ስልክ ቁጥሬን አጋራ',
    playButton: 'ቢንጎ ተጫወት',
    playPrompt: 'ወደ አዳራሹ ለመግባት ከታች ያለውን አዝራር ይጫኑ።',
    contactSaved: (phone) =>
      `ቁጥርዎ ${phone} ተረጋግጧል። አሁን መጫወት ይችላሉ። የሚያሸንፉት ገንዘብ በጨዋታ ቦርሳዎ ውስጥ ይቀመጣል።`,
    contactVerified: 'የስልክ ቁጥርዎ ተረጋግጧል።',
    contactButtonHint: 'ማንነትዎን ለማረጋገጥ ከታች “ስልክ ቁጥሬን አጋራ” የሚለውን ይጫኑ።',
    help:
      'ቢንጎ አዳራሽ የቀጥታ ቢንጎ ጨዋታ ነው።\n\n/start — ጨዋታውን ይክፈቱ\n/verify — ስልክ ቁጥርዎን እንደገና ያረጋግጡ\n/dashboard — ሰራተኞችና ወኪሎች፦ ኮንሶልዎን ይክፈቱ\n/help — ይህ መልእክት',
    notOwnContact: 'እባክዎ የራስዎን ቁጥር በአዝራሩ ያጋሩ፣ የሌላ ሰው ኮንታክት አይደለም።',
    invalidPhone: 'ቴሌግራም የላከውን ቁጥር ማንበብ አልተቻለም። እባክዎ እንደገና ይሞክሩ።',
    phoneTaken: 'ይህ ቁጥር ከሌላ መዝገብ ጋር ተገናኝቷል። በመተግበሪያው ውስጥ ድጋፍን ያግኙ።',
    staffWelcome: 'እንደ ሰራተኛ ገብተዋል። ዳሽቦርድዎን ከታች ይክፈቱ።',
    staffLinked: 'የቴሌግራም መዝገብዎ ተገናኝቷል። ዳሽቦርድዎን ከታች ይክፈቱ።',
    staffLinkInvalid: 'ይህ የሰራተኛ አገናኝ ጊዜው አልፏል ወይም አስቀድሞ ጥቅም ላይ ውሏል። አስተዳዳሪን አዲስ አገናኝ ይጠይቁ።',
    dashboardAdmin: 'የአስተዳዳሪ ኮንሶል',
    dashboardSupport: 'የድጋፍ ጠረጴዛ',
    dashboardAgent: 'የወኪል ዳሽቦርድ',
    appNotConfigured: 'የጨዋታ አገናኙ አልተዘጋጀም። እባክዎ በኋላ ይሞክሩ።',
    somethingWentWrong: 'የተሳሳተ ነገር ተከስቷል። እባክዎ ከጥቂት ጊዜ በኋላ ይሞክሩ።',
  },
};
