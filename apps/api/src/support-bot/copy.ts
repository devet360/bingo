export type SupportLocale = 'en' | 'am';

interface AccountSnapshotText {
  name: string;
  phone: string;
  verified: boolean;
  available: string;
  bonus: string;
  locked: string;
  deposits: string[];
  withdrawals: string[];
}

export interface SupportCopy {
  welcome: (name: string) => string;
  menuTitle: string;
  offlineNote: (hours: string) => string;

  depositTitle: string;
  depositBody: string;
  withdrawalTitle: string;
  withdrawalBody: string;

  faqTitle: string;
  faqBody: string;
  faq: Record<'deposit' | 'withdrawal' | 'fees' | 'account', string>;

  accountTitle: string;
  accountBody: (snapshot: AccountSnapshotText) => string;

  agentOnline: (code: string) => string;
  agentOffline: (code: string, hours: string) => string;
  agentResumed: (code: string) => string;
  chatClosed: string;
  waitingHint: string;
  photoHint: string;
  unsupported: string;
  rateLimited: string;
  unregistered: (botUsername?: string) => string;
  staff: string;
  photoTooLarge: string;
  photoFailed: string;
  error: string;

  buttons: {
    deposit: string;
    withdrawal: string;
    account: string;
    faq: string;
    agent: string;
    back: string;
    menu: string;
    wallet: string;
    endChat: string;
    language: string;
  };
  faqButtons: {
    deposit: string;
    withdrawal: string;
    fees: string;
    account: string;
  };
}

function faqLines(items: string[]): string {
  return items.length ? items.join('\n') : '—';
}

export const supportCopy: Record<SupportLocale, SupportCopy> = {
  en: {
    welcome: (name) =>
      `Hi ${name}! 👋\nI'm the Bingo 251 support assistant.\n\nPick a topic below, or talk to a person.`,
    menuTitle: 'How can we help?',
    offlineNote: (hours) =>
      `\n\n🕒 Agents are offline right now (${hours}). Self-service still works — leave a message and we'll reply when we open.`,

    depositTitle: '💳 Deposits',
    depositBody:
      'Deposits are funded by our agents.\n\n1. Open your Wallet and choose Deposit.\n2. Pick an agent and the amount, then pay to the account shown.\n3. The agent credits your wallet after the transfer.\n\nIf a deposit is late, open it in Wallet → Deposits to see its status.',
    withdrawalTitle: '💸 Withdrawals',
    withdrawalBody:
      'Withdrawals are paid out by an agent.\n\n1. Open Wallet → Withdraw and choose your payout account.\n2. You receive a payout code — share it only with the agent who pays you.\n3. The agent pays the amount and confirms; the status changes to Settled.\n\nFollow progress in Wallet → Withdrawals.',

    faqTitle: '❓ Help & FAQ',
    faqBody: 'Choose a question:',
    faq: {
      deposit:
        'Deposit not credited yet?\n\n• Open the deposit in Wallet → Deposits and check whether an agent has claimed it.\n• If you already paid, send the transfer receipt or a screenshot in this chat.\n• Never share your wallet password or payout code with anyone.',
      withdrawal:
        'Withdrawal not paid yet?\n\n• Open Wallet → Withdrawals to see the status.\n• Escrowed: waiting for an agent to take the payout.\n• Processing: an agent is paying; keep your payout code ready.\n• Settled: the agent marked it paid. If the money did not arrive, send us the payout code.',
      fees:
        'Fees & limits\n\nDeposit and withdrawal commissions are set per agent; the exact fee is shown before you confirm. Bonuses go to your bonus balance and become withdrawable once wagering is complete.',
      account:
        'Account & phone\n\nYour account is created when you share your phone number with our main bot. Change the language from this chat’s menu. If your phone number changed, contact support.',
    },

    accountTitle: '👤 My account',
    accountBody: (snapshot) =>
      [
        `Name: ${snapshot.name}`,
        `Phone: ${snapshot.phone}${snapshot.verified ? ' ✓' : ''}`,
        `Balance: ${snapshot.available} ETB`,
        `Bonus: ${snapshot.bonus} ETB`,
        `In play: ${snapshot.locked} ETB`,
        '',
        `Open deposits: ${faqLines(snapshot.deposits)}`,
        `Open withdrawals: ${faqLines(snapshot.withdrawals)}`,
      ].join('\n'),

    agentOnline: (code) =>
      `You're connected to the support desk (${code}).\n\nAn agent will reply here. Describe your issue in one or more messages — you can also send a screenshot.\n\nTap ⏹ End chat when you're done.`,
    agentOffline: (code, hours) =>
      `You're connected to the support desk (${code}).\n\nOur agents are offline right now (${hours}). Leave your message here and we'll reply when we open.\n\nTap ⏹ End chat when you're done.`,
    agentResumed: (code) =>
      `You already have an open chat with support (${code}). Send your message below.`,
    chatClosed: 'Chat closed. Thanks for reaching out! Tap /start if you need anything else.',
    waitingHint:
      'I didn’t understand that. Tap /menu to choose an option, or “Talk to an agent” to chat with a person.',
    photoHint:
      'Start a chat with an agent first (Talk to an agent), then send the screenshot.',
    unsupported: 'Please send text or a screenshot.',
    rateLimited: 'You’re sending messages too quickly. Please wait a minute and try again.',
    unregistered: (botUsername) =>
      `I couldn't find your Bingo 251 account. Open ${botUsername ? `@${botUsername}` : 'our main bot'}, share your phone number to create one, then come back.`,
    staff: 'This bot is for players. Use your staff console to manage the platform.',
    photoTooLarge: 'That screenshot is too large. Please send a smaller image.',
    photoFailed: 'I couldn’t read that screenshot. Please try again.',
    error: 'Something went wrong. Please try again in a moment.',

    buttons: {
      deposit: '💳 Deposit',
      withdrawal: '💸 Withdrawal',
      account: '👤 My account',
      faq: '❓ Help & FAQ',
      agent: '💬 Talk to an agent',
      back: '← Back',
      menu: '☰ Menu',
      wallet: 'Open wallet',
      endChat: '⏹ End chat',
      language: '🌐 አማርኛ',
    },
    faqButtons: {
      deposit: 'Deposit not credited',
      withdrawal: 'Withdrawal not paid',
      fees: 'Fees & limits',
      account: 'Account & phone',
    },
  },

  am: {
    welcome: (name) =>
      `ሰላም ${name}! 👋\nየቢንጎ 251 የድጋፍ አጋዥ ነኝ።\n\nከታች ካሉት ርዕሶች አንዱን ይምረጡ ወይም ከሰራተኛ ጋር ይወያዩ።`,
    menuTitle: 'እንዴት ልንረዳዎ እንችላለን?',
    offlineNote: (hours) =>
      `\n\n🕒 አሁን ወኪሎች ከመስመር ውጭ ናቸው (${hours})። ራስን መርዳት አሁንም ይሰራል — መልእክትዎን ይተው ስንከፍት እንመልስልዎታለን።`,

    depositTitle: '💳 ገንዘብ ማስገባት',
    depositBody:
      'ተቀማጭ ገንዘብ በወኪሎቻችን ይቀበላል።\n\n1. ቦርሳዎን ከፍተው “ገንዘብ አስገባ” ይምረጡ።\n2. ወኪልና መጠኑን ይምረጡ፣ ከዚያ በሚታየው አካውንት ይክፈሉ።\n3. ወኪሉ ከዝውውሩ በኋላ ቦርሳዎን ይሞላል።\n\nተቀማጭው ከዘገየ ቦርሳ → ተቀማጮች ውስጥ ሁኔታውን ይመልከቱ።',
    withdrawalTitle: '💸 ገንዘብ ማውጣት',
    withdrawalBody:
      'ወጪ ገንዘብ በወኪል ይከፈላል።\n\n1. ቦርሳ → ገንዘብ አውጣ ይክፈቱና የገንዘብ መቀበያ አካውንትዎን ይምረጡ።\n2. የክፍያ ኮድ ይደርስዎታል — ለሚከፍልዎ ወኪል ብቻ ያጋሩት።\n3. ወኪሉ ከከፈለ በኋላ ያረጋግጣል፤ ሁኔታው “ተከፍሏል” ይሆናል።\n\nሂደቱን ቦርሳ → ወጪዎች ውስጥ ይከታተሉ።',

    faqTitle: '❓ እርዳታና ተደጋጋሚ ጥያቄዎች',
    faqBody: 'ጥያቄ ይምረጡ፦',
    faq: {
      deposit:
        'ተቀማጭ ገንዘብ አልገባም?\n\n• ቦርሳ → ተቀማጮች ውስጥ ወኪሉ መውሰዱን ያረጋግጡ።\n• ከከፈሉ የዝውውር ደረሰኝ ወይም ስክሪንሾት በዚህ ውይይት ይላኩ።\n• የቦርሳ የይለፍ ቃልዎን ወይም የክፍያ ኮድዎን ለማንም አያጋሩ።',
      withdrawal:
        'ወጪ ገንዘብ አልተከፈለም?\n\n• ቦርሳ → ወጪዎች ውስጥ ሁኔታውን ይመልከቱ።\n• “በእጅ ያዝ”፦ ወኪል እስኪወስድ ይጠብቃል።\n• “በሂደት ላይ”፦ ወኪል እየከፈለ ነው፤ የክፍያ ኮድዎን ይዘው ይጠብቁ።\n• “ተከፍሏል”፦ ወኪሉ እንደከፈለ አረጋግጧል። ገንዘቡ ካልደረሰ የክፍያ ኮዱን ይላኩልን።',
      fees:
        'ክፍያዎችና ገደቦች\n\nየተቀማጭና ወጪ ኮሚሽን በወኪል ይወሰናል፤ ትክክለኛው ክፍያ ከማረጋገጥዎ በፊት ይታያል። ቦነሶች ወደ ቦነስ ቀሪ ሂሳብ ይገባሉ፤ የማሸነፊያ መስፈርቱ ከተሟላ በኋላ ሊወጡ ይችላሉ።',
      account:
        'መዝገብና ስልክ\n\nመዝገብዎ የሚከፈተው የስልክ ቁጥርዎን ከዋናው ቦት ጋር ሲያጋሩ ነው። ቋንቋውን በዚህ ውይይት ምናሌ ይቀይሩ። ስልክ ቁጥርዎ ከተቀየረ ድጋፍን ያግኙ።',
    },

    accountTitle: '👤 መዝገቤ',
    accountBody: (snapshot) =>
      [
        `ስም፦ ${snapshot.name}`,
        `ስልክ፦ ${snapshot.phone}${snapshot.verified ? ' ✓' : ''}`,
        `ቀሪ ሂሳብ፦ ${snapshot.available} ብር`,
        `ቦነስ፦ ${snapshot.bonus} ብር`,
        `በጨዋታ ላይ፦ ${snapshot.locked} ብር`,
        '',
        `ክፍት ተቀማጮች፦ ${faqLines(snapshot.deposits)}`,
        `ክፍት ወጪዎች፦ ${faqLines(snapshot.withdrawals)}`,
      ].join('\n'),

    agentOnline: (code) =>
      `ከድጋፍ ጠረጴዛ ጋር ተገናኝተዋል (${code})።\n\nወኪል እዚህ ይመልስልዎታል። ችግርዎን በአንድ ወይም ከዚያ በላይ መልእክቶች ይግለጹ — ስክሪንሾትም መላክ ይችላሉ።\n\nሲጨርሱ “⏹ ውይይቱን ጨርስ” ይጫኑ።`,
    agentOffline: (code, hours) =>
      `ከድጋፍ ጠረጴዛ ጋር ተገናኝተዋል (${code})።\n\nአሁን ወኪሎች ከመስመር ውጭ ናቸው (${hours})። መልእክትዎን እዚህ ይተው፤ ስንከፍት እንመልስልዎታለን።\n\nሲጨርሱ “⏹ ውይይቱን ጨርስ” ይጫኑ።`,
    agentResumed: (code) => `ከድጋፍ ጋር ክፍት ውይይት አለዎት (${code})። መልእክትዎን ከታች ይላኩ።`,
    chatClosed: 'ውይይቱ ተዘግቷል። ስላገኙን እናመሰግናለን! ሌላ ነገር ካለ /start ይጫኑ።',
    waitingHint: 'ግንዛቤ አልገባኝም። /menu ይጫኑ ወይም “💬 ከወኪል ጋር ተወያይ” ይምረጡ።',
    photoHint: 'መጀመሪያ ከወኪል ጋር ውይይት ይክፈቱ (ከወኪል ጋር ተወያይ)፣ ከዚያ ስክሪንሾቱን ይላኩ።',
    unsupported: 'እባክዎ ጽሑፍ ወይም ስክሪንሾት ይላኩ።',
    rateLimited: 'በጣም በፍጥነት እየላኩ ነው። እባክዎ አንድ ደቂቃ ይጠብቁ።',
    unregistered: (botUsername) =>
      `የቢንጎ 251 መዝገብዎን ማግኘት አልቻልኩም። ${botUsername ? `@${botUsername} ` : 'ዋናውን ቦት '}ከፍተው የስልክ ቁጥርዎን ያጋሩ፣ ከዚያ ይመለሱ።`,
    staff: 'ይህ ቦት ለተጫዋቾች ነው። መድረኩን ለማስተዳደር የሰራተኛ ኮንሶልዎን ይጠቀሙ።',
    photoTooLarge: 'ስክሪንሾቱ በጣም ትልቅ ነው። ትንሽ ምስል ይላኩ።',
    photoFailed: 'ስክሪንሾቱን ማንበብ አልቻልኩም። እባክዎ እንደገና ይሞክሩ።',
    error: 'የተሳሳተ ነገር ተከስቷል። እባክዎ እንደገና ይሞክሩ።',

    buttons: {
      deposit: '💳 ገንዘብ አስገባ',
      withdrawal: '💸 ገንዘብ አውጣ',
      account: '👤 መዝገቤ',
      faq: '❓ እርዳታና ጥያቄዎች',
      agent: '💬 ከወኪል ጋር ተወያይ',
      back: '← ተመለስ',
      menu: '☰ ምናሌ',
      wallet: 'ቦርሳ ክፈት',
      endChat: '⏹ ውይይቱን ጨርስ',
      language: '🌐 English',
    },
    faqButtons: {
      deposit: 'ተቀማጭ አልገባም',
      withdrawal: 'ወጪ አልተከፈለም',
      fees: 'ክፍያዎችና ገደቦች',
      account: 'መዝገብና ስልክ',
    },
  },
};
