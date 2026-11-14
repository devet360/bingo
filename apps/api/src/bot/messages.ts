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
  contactSaved: (phone: string) => string;
  contactButtonHint: string;
  help: string;
  notOwnContact: string;
  invalidPhone: string;
  phoneTaken: string;
  staffWebOnly: string;
  appNotConfigured: string;
  somethingWentWrong: string;
}

export const botCopy: Record<BotLocale, BotCopy> = {
  en: {
    welcomeVerify:
      'Welcome to Bingo Hall! To create your player account, share your phone number using the button below. We only use it to verify you.',
    welcomeBack: 'Welcome back! Your number is verified — tap below to enter the hall.',
    shareContactButton: 'Share my number',
    playButton: 'Play Bingo',
    contactSaved: (phone) =>
      `Your number ${phone} is verified. You can now play. Winnings are credited to your in-game wallet.`,
    contactButtonHint: 'Tap “Share my number” below so we can verify you.',
    help:
      'Bingo Hall is a real-time bingo game.\n\n/start — open the game\n/verify — re-verify your phone number\n/help — this message',
    notOwnContact: 'Please share your own number using the button, not a contact card.',
    invalidPhone: 'Telegram sent a number we could not read. Please try again.',
    phoneTaken: 'That number is already linked to another account. Contact support in the app.',
    staffWebOnly: 'Staff accounts sign in on the web portal, not in the bot.',
    appNotConfigured: 'The game link is not configured yet. Please try again later.',
    somethingWentWrong: 'Something went wrong. Please try again in a moment.',
  },
  am: {
    welcomeVerify:
      'እንኳን ወደ ቢንጎ አዳራሽ በደህና መጡ! የተጫዋች መዝገብዎን ለመክፈት ከታች ባለው አዝራር የስልክ ቁጥርዎን ያጋሩ። ቁጥሩን የምንጠቀመው ማንነትዎን ለማረጋገጥ ብቻ ነው።',
    welcomeBack: 'እንኳን ደግመው መጡ! ቁጥርዎ ተረጋግጧል — ለመግባት ከታች ይጫኑ።',
    shareContactButton: 'ስልክ ቁጥሬን አጋራ',
    playButton: 'ቢንጎ ተጫወት',
    contactSaved: (phone) =>
      `ቁጥርዎ ${phone} ተረጋግጧል። አሁን መጫወት ይችላሉ። የሚያሸንፉት ገንዘብ በጨዋታ ቦርሳዎ ውስጥ ይቀመጣል።`,
    contactButtonHint: 'ማንነትዎን ለማረጋገጥ ከታች “ስልክ ቁጥሬን አጋራ” የሚለውን ይጫኑ።',
    help:
      'ቢንጎ አዳራሽ የቀጥታ ቢንጎ ጨዋታ ነው።\n\n/start — ጨዋታውን ይክፈቱ\n/verify — ስልክ ቁጥርዎን እንደገና ያረጋግጡ\n/help — ይህ መልእክት',
    notOwnContact: 'እባክዎ የራስዎን ቁጥር በአዝራሩ ያጋሩ፣ የሌላ ሰው ኮንታክት አይደለም።',
    invalidPhone: 'ቴሌግራም የላከውን ቁጥር ማንበብ አልተቻለም። እባክዎ እንደገና ይሞክሩ።',
    phoneTaken: 'ይህ ቁጥር ከሌላ መዝገብ ጋር ተገናኝቷል። በመተግበሪያው ውስጥ ድጋፍን ያግኙ።',
    staffWebOnly: 'የሰራተኛ መዝገቦች በድረ-ገጽ ፖርታል ብቻ ይገባሉ።',
    appNotConfigured: 'የጨዋታ አገናኙ አልተዘጋጀም። እባክዎ በኋላ ይሞክሩ።',
    somethingWentWrong: 'የተሳሳተ ነገር ተከስቷል። እባክዎ ከጥቂት ጊዜ በኋላ ይሞክሩ።',
  },
};
