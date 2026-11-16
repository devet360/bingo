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

interface TransactionDetailText {
  amount: string;
  net?: string;
  method: string;
  created: string;
  status: string;
  closes?: string;
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

  depositRecentTitle: string;
  depositRecentEmpty: string;
  withdrawalRecentTitle: string;
  withdrawalRecentEmpty: string;
  txListHint: string;
  txDetailTitle: (kind: 'deposit' | 'withdrawal', reference: string) => string;
  txDetailBody: (info: TransactionDetailText) => string;
  txDepositProcessing: (when: string) => string;
  txDepositOverdue: (when: string) => string;
  txDepositCredited: string;
  txWithdrawalProcessing: (when: string) => string;
  txWithdrawalOverdue: (when: string) => string;
  txWithdrawalSettled: string;
  txDeclined: string;
  txCancelled: string;
  txExpired: string;
  txUnderReview: string;

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
    refresh: string;
    report: string;
    newDeposit: string;
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
        `Recent deposits: ${faqLines(snapshot.deposits)}`,
        `Recent withdrawals: ${faqLines(snapshot.withdrawals)}`,
      ].join('\n'),

    depositRecentTitle: '💳 Recent deposits',
    depositRecentEmpty: 'You have no deposits yet. Open your wallet to make your first one.',
    withdrawalRecentTitle: '💸 Recent withdrawals',
    withdrawalRecentEmpty: 'You have no withdrawals yet.',
    txListHint: 'Tap a transaction to see its status.',
    txDetailTitle: (kind, reference) =>
      `${kind === 'deposit' ? '💳 Deposit' : '💸 Withdrawal'} ${reference}`,
    txDetailBody: (info) =>
      [
        `Amount: ${info.amount} ETB`,
        ...(info.net ? [`Net payout: ${info.net} ETB`] : []),
        `Method: ${info.method}`,
        `Created: ${info.created}`,
        `Status: ${info.status}`,
        ...(info.closes ? [`Processing window ends: ${info.closes}`] : []),
      ].join('\n'),
    txDepositProcessing: (when) =>
      `Your deposit is being processed. Please wait patiently — most deposits finish within the window above. If it is not credited by ${when}, come back here and tap “Report a problem”.`,
    txDepositOverdue: (when) =>
      `The expected processing window ended at ${when} and the deposit is still not credited. Tap “Report a problem” below or talk to an agent so we can check it for you.`,
    txDepositCredited:
      'This deposit was credited to your wallet. If your balance does not show it, tap “Report a problem”.',
    txWithdrawalProcessing: (when) =>
      `Your payout is being processed. Keep your payout code ready and wait patiently. If the agent has not paid you by ${when}, come back here and tap “Report a problem”.`,
    txWithdrawalOverdue: (when) =>
      `The expected payout window ended at ${when} and the withdrawal is still open. Tap “Report a problem” or talk to an agent so we can follow it up.`,
    txWithdrawalSettled:
      'The agent marked this payout as paid. If you did not receive the money, tap “Report a problem” and send us the payout code.',
    txDeclined:
      'This request was declined. You can start a new one from your wallet, or talk to an agent if you think this is a mistake.',
    txCancelled:
      'This request was cancelled and no money moved. You can create a new request from your wallet.',
    txExpired:
      'This request expired before it was completed and no money moved. You can create a new one from your wallet.',
    txUnderReview:
      'This transaction is under review. Our team will get back to you; you can also talk to an agent for an update.',

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
      refresh: '🔄 Refresh',
      report: '⚠️ Report a problem',
      newDeposit: '➕ New deposit',
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
        `የቅርብ ጊዜ ተቀማጮች፦ ${faqLines(snapshot.deposits)}`,
        `የቅርብ ጊዜ ወጪዎች፦ ${faqLines(snapshot.withdrawals)}`,
      ].join('\n'),

    depositRecentTitle: '💳 የቅርብ ጊዜ ተቀማጮች',
    depositRecentEmpty: 'እስካሁን ተቀማጭ የለዎትም። መጀመሪያውን ለማድረግ ቦርሳዎን ይክፈቱ።',
    withdrawalRecentTitle: '💸 የቅርብ ጊዜ ወጪዎች',
    withdrawalRecentEmpty: 'እስካሁን ወጪ የለዎትም።',
    txListHint: 'ሁኔታውን ለማየት ግብይቱን ይንኩ።',
    txDetailTitle: (kind, reference) =>
      `${kind === 'deposit' ? '💳 ተቀማጭ' : '💸 ወጪ'} ${reference}`,
    txDetailBody: (info) =>
      [
        `መጠን፦ ${info.amount} ብር`,
        ...(info.net ? [`የሚከፈል፦ ${info.net} ብር`] : []),
        `መንገድ፦ ${info.method}`,
        `የተፈጠረበት፦ ${info.created}`,
        `ሁኔታ፦ ${info.status}`,
        ...(info.closes ? [`የሂደት ጊዜ የሚያበቃው፦ ${info.closes}`] : []),
      ].join('\n'),
    txDepositProcessing: (when) =>
      `ተቀማጭዎ በሂደት ላይ ነው። እባክዎ በትዕግስት ይጠብቁ — አብዛኞቹ ተቀማጮች ከላይ በተጠቀሰው ጊዜ ውስጥ ይጠናቀቃሉ። በ${when} ካልገባ ወደዚህ ተመልሰው “⚠️ ችግር ያሳውቁ” ይጫኑ።`,
    txDepositOverdue: (when) =>
      `የሂደቱ ጊዜ በ${when} አብቅቷል ግን ተቀማጭው አልገባም። “⚠️ ችግር ያሳውቁ” ይጫኑ ወይም ከወኪል ጋር ይወያዩ፤ እኛ እንመረምራለን።`,
    txDepositCredited:
      'ይህ ተቀማጭ ወደ ቦርሳዎ ገብቷል። ቀሪ ሂሳብዎ ላይ ካላዩት “⚠️ ችግር ያሳውቁ” ይጫኑ።',
    txWithdrawalProcessing: (when) =>
      `ክፍያዎ በሂደት ላይ ነው። የክፍያ ኮድዎን ይዘው በትዕግስት ይጠብቁ። ወኪሉ በ${when} ካልከፈለዎ ወደዚህ ተመልሰው “⚠️ ችግር ያሳውቁ” ይጫኑ።`,
    txWithdrawalOverdue: (when) =>
      `የክፍያው ጊዜ በ${when} አብቅቷል ግን ወጪው አሁንም ክፍት ነው። “⚠️ ችግር ያሳውቁ” ይጫኑ ወይም ከወኪል ጋር ይወያዩ፤ እንከታተለዋለን።`,
    txWithdrawalSettled:
      'ወኪሉ ክፍያውን እንደተከፈለ አረጋግጧል። ገንዘቡ ካልደረሰዎ “⚠️ ችግር ያሳውቁ” ይጫኑና የክፍያ ኮዱን ይላኩልን።',
    txDeclined:
      'ይህ ጥያቄ ተቀባይነት አላገኘም። ከቦርሳዎ አዲስ መጀመር ይችላሉ፤ ስህተት ከሆነ ከወኪል ጋር ይወያዩ።',
    txCancelled: 'ይህ ጥያቄ ተሰርዟል፤ ገንዘብ አልተንቀሳቀሰም። ከቦርሳዎ አዲስ ጥያቄ መፍጠር ይችላሉ።',
    txExpired: 'ይህ ጥያቄ ከመጠናቀቁ በፊት ጊዜው አልፏል፤ ገንዘብ አልተንቀሳቀሰም። ከቦርሳዎ አዲስ መፍጠር ይችላሉ።',
    txUnderReview: 'ይህ ግብይት በግምገማ ላይ ነው። ቡድናችን ወደ ኋላ ያገኝዎታል፤ መረጃ ለማግኘት ከወኪል ጋርም መወያየት ይችላሉ።',

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
      refresh: '🔄 አድስ',
      report: '⚠️ ችግር ያሳውቁ',
      newDeposit: '➕ አዲስ ተቀማጭ',
    },
    faqButtons: {
      deposit: 'ተቀማጭ አልገባም',
      withdrawal: 'ወጪ አልተከፈለም',
      fees: 'ክፍያዎችና ገደቦች',
      account: 'መዝገብና ስልክ',
    },
  },
};
