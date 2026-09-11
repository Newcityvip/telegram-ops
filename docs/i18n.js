(() => {
const translations = {
  bn: {
    "Sign in to your operations workspace.": "আপনার অপারেশনস ওয়ার্কস্পেসে সাইন ইন করুন।",
    "Username": "ইউজারনেম", "Password": "পাসওয়ার্ড", "Sign In": "সাইন ইন", "Logout": "লগআউট",
    "WORKSPACE / OVERVIEW": "ওয়ার্কস্পেস / সারসংক্ষেপ", "Operations dashboard": "অপারেশনস ড্যাশবোর্ড",
    "A clear view of incoming cases and agent ownership.": "আসা কেস ও এজেন্টের দায়িত্ব এক নজরে দেখুন।",
    "Follow Up Request": "ফলো-আপ রিকোয়েস্ট", "Refresh": "রিফ্রেশ",
    "Total cases": "মোট কেস", "All received cases": "সব প্রাপ্ত কেস", "Open": "খোলা",
    "In the operations queue": "অপারেশনস কিউতে আছে", "Unassigned": "অ্যাসাইন করা হয়নি",
    "Awaiting agent ownership": "এজেন্ট অ্যাসাইন হওয়ার অপেক্ষায়", "Active agents": "সক্রিয় এজেন্ট",
    "Available for assignment": "অ্যাসাইন করার জন্য উপলভ্য", "Shop assignments": "শপ অ্যাসাইনমেন্ট",
    "Active shop mappings": "সক্রিয় শপ ম্যাপিং", "Case queue": "কেস কিউ", "Newest cases first": "নতুন কেস আগে",
    "Status": "স্ট্যাটাস", "All statuses": "সব স্ট্যাটাস", "Agent": "এজেন্ট", "All agents": "সব এজেন্ট",
    "Shop code": "শপ কোড", "Apply filters": "ফিল্টার প্রয়োগ করুন", "Clear": "ফিল্টার মুছুন",
    "Case ID": "কেস আইডি", "Received": "প্রাপ্তির সময়", "Shop": "শপ", "Rule": "রুল",
    "Load older cases": "আগের কেস দেখুন", "Follow Up History": "ফলো-আপ ইতিহাস",
    "Submitted requests and Telegram delivery status": "জমা দেওয়া রিকোয়েস্ট ও Telegram পাঠানোর স্ট্যাটাস",
    "Request ID": "রিকোয়েস্ট আইডি", "Submitted": "জমা দেওয়ার সময়", "Submitted by": "জমা দিয়েছেন",
    "Category": "ক্যাটাগরি", "Group": "গ্রুপ", "Wallet": "ওয়ালেট",
    "Shop assignments": "শপ অ্যাসাইনমেন্ট", "Sync from Google Sheet": "Google Sheet থেকে সিঙ্ক করুন",
    "User management": "ইউজার ম্যানেজমেন্ট", "Dashboard accounts stored in D1": "D1-এ সংরক্ষিত ড্যাশবোর্ড অ্যাকাউন্ট",
    "Create user": "ইউজার তৈরি করুন", "Display name": "প্রদর্শিত নাম", "Role": "ভূমিকা", "Created": "তৈরির সময়",
    "CASE DETAILS": "কেসের বিস্তারিত", "Case": "কেস", "Transaction slip": "লেনদেনের স্লিপ",
    "Zoom Out": "ছোট করুন", "Fit / Reset": "ফিট / রিসেট", "Zoom In": "বড় করুন", "Full View": "পূর্ণ ভিউ", "Exit Full View": "পূর্ণ ভিউ বন্ধ করুন",
    "ADMINISTRATION": "অ্যাডমিন ব্যবস্থাপনা", "Active account": "সক্রিয় অ্যাকাউন্ট",
    "SECURITY": "নিরাপত্তা", "Reset password": "পাসওয়ার্ড রিসেট", "New password": "নতুন পাসওয়ার্ড",
    "NEW REQUEST": "নতুন রিকোয়েস্ট", "Follow Up Category": "ফলো-আপ ক্যাটাগরি",
    "Select category": "ক্যাটাগরি নির্বাচন করুন", "Off Wallet Follow Up Request": "অফ ওয়ালেট ফলো-আপ রিকোয়েস্ট",
    "Request to Close Shop": "শপ বন্ধ করার রিকোয়েস্ট", "Agent Group": "এজেন্ট গ্রুপ", "Select group": "গ্রুপ নির্বাচন করুন",
    "Continue": "এগিয়ে যান", "Shop Name": "শপের নাম", "Wallet Number": "ওয়ালেট নম্বর",
    "Wallet Type": "ওয়ালেটের ধরন", "Select wallet": "ওয়ালেট নির্বাচন করুন", "Deposit OFF from": "ডিপোজিট বন্ধ থাকার সময় শুরু",
    "Current Balance": "বর্তমান ব্যালেন্স", "B2B Due": "B2B বকেয়া", "Request Type": "রিকোয়েস্টের ধরন", "Reason": "কারণ",
    "Request to close this wallet and withdraw all remaining balance": "এই ওয়ালেটটি বন্ধ করে অবশিষ্ট সব ব্যালেন্স তুলে নেওয়ার অনুরোধ",
    "This wallet will be replaced with a new agent number": "এই ওয়ালেটটি নতুন এজেন্ট নম্বর দিয়ে প্রতিস্থাপন করা হবে",
    "Back": "ফিরে যান", "Cancel": "বাতিল", "Review": "রিভিউ",
    "Confirm the complete Telegram message before sending.": "পাঠানোর আগে সম্পূর্ণ Telegram বার্তাটি যাচাই করুন।",
    "Back / Edit": "ফিরে গিয়ে সম্পাদনা করুন", "Submit": "জমা দিন", "Close": "বন্ধ করুন",
    "View": "দেখুন", "View →": "দেখুন →", "View Slip": "স্লিপ দেখুন", "Assign": "অ্যাসাইন করুন",
    "Select agent": "এজেন্ট নির্বাচন করুন", "Not assigned": "অ্যাসাইন করা হয়নি", "Response destination": "উত্তরের গন্তব্য",
    "Send operational response": "অপারেশনাল উত্তর পাঠান",
    "Choose the configured response. Its Telegram destination is selected automatically.": "কনফিগার করা উত্তর নির্বাচন করুন। Telegram গন্তব্য স্বয়ংক্রিয়ভাবে নির্ধারিত হবে।",
    "Reset Password": "পাসওয়ার্ড রিসেট", "Deactivate": "নিষ্ক্রিয় করুন", "Activate": "সক্রিয় করুন",
    "Active": "সক্রিয়", "Inactive": "নিষ্ক্রিয়", "Loading…": "লোড হচ্ছে…", "Unable to load cases.": "কেস লোড করা যায়নি।",
    "Loading cases…": "কেস লোড হচ্ছে…", "Loading follow-up requests…": "ফলো-আপ রিকোয়েস্ট লোড হচ্ছে…",
    "OPEN": "খোলা", "ANSWERED": "উত্তর দেওয়া হয়েছে", "UNASSIGNED": "অ্যাসাইন করা হয়নি",
    "SENT": "পাঠানো হয়েছে", "FAILED": "ব্যর্থ হয়েছে", "PENDING": "অপেক্ষমাণ", "CLOSED": "বন্ধ হয়েছে",
    "No cases match these filters.": "এই ফিল্টারের সঙ্গে কোনো কেস মেলেনি।",
    "No follow-up requests yet.": "এখনও কোনো ফলো-আপ রিকোয়েস্ট নেই।", "No users found.": "কোনো ইউজার পাওয়া যায়নি।",
    "Loading users…": "ইউজার লোড হচ্ছে…", "Action": "অ্যাকশন", "Actions": "অ্যাকশনসমূহ",
    "Synchronize mappings from Google Sheet?": "Google Sheet থেকে ম্যাপিং সিঙ্ক করবেন?",
    "Telegram ingestion is unchanged. Assigning a case does not change shop mappings or send a Telegram message.": "Telegram ইনজেশন অপরিবর্তিত। কেস অ্যাসাইন করলে শপ ম্যাপিং বদলায় না বা Telegram বার্তা পাঠানো হয় না।",
    "Image": "ছবি", "Follow Up Request #{id} sent successfully.": "ফলো-আপ রিকোয়েস্ট #{id} সফলভাবে পাঠানো হয়েছে।",
    "Inserted {inserted}, updated {updated}, deactivated {deactivated}, unchanged {unchanged}.": "যোগ হয়েছে {inserted}, আপডেট হয়েছে {updated}, নিষ্ক্রিয় হয়েছে {deactivated}, অপরিবর্তিত {unchanged}।",
    "Set a new password for {user}.": "{user}-এর জন্য নতুন পাসওয়ার্ড সেট করুন।",
    "You cannot deactivate your own account": "নিজের অ্যাকাউন্ট নিষ্ক্রিয় করা যাবে না",
    "Invalid username or password.": "ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।",
    "Select a category and agent group.": "একটি ক্যাটাগরি ও এজেন্ট গ্রুপ নির্বাচন করুন।",
    "Follow-up history could not be loaded.": "ফলো-আপ ইতিহাস লোড করা যায়নি।",
    "Request details could not be loaded.": "রিকোয়েস্টের বিস্তারিত লোড করা যায়নি।",
    "The selected agent group is unavailable.": "নির্বাচিত এজেন্ট গ্রুপটি পাওয়া যাচ্ছে না।",
    "Check all required fields and ensure the shop matches the selected group.": "সব আবশ্যক তথ্য দিন এবং শপটি নির্বাচিত গ্রুপের সঙ্গে মিলেছে কি না দেখুন।",
    "The group configuration changed. Go back and review the message again.": "গ্রুপ কনফিগারেশন বদলেছে। ফিরে গিয়ে বার্তাটি আবার রিভিউ করুন।",
    "Telegram delivery is not configured.": "Telegram ডেলিভারি কনফিগার করা নেই।",
    "The request could not be saved.": "রিকোয়েস্টটি সংরক্ষণ করা যায়নি।",
    "Telegram delivery failed. The failed request was preserved.": "Telegram-এ পাঠানো যায়নি। ব্যর্থ রিকোয়েস্টটি সংরক্ষিত আছে।",
    "Telegram accepted the request, but final status recording failed. Do not submit it again.": "Telegram রিকোয়েস্টটি গ্রহণ করেছে, কিন্তু চূড়ান্ত স্ট্যাটাস সংরক্ষণ হয়নি। আবার জমা দেবেন না।",
    "The follow-up request could not be completed.": "ফলো-আপ রিকোয়েস্টটি সম্পন্ন করা যায়নি।",
    "Response choices are not configured for this case.": "এই কেসের উত্তরগুলো কনফিগার করা নেই।",
    "That response is not allowed for this case.": "এই কেসে ওই উত্তরটি অনুমোদিত নয়।",
    "No Telegram destination is configured for this case.": "এই কেসের Telegram গন্তব্য কনফিগার করা নেই।",
    "The configured Telegram destination is unavailable.": "কনফিগার করা Telegram গন্তব্যটি পাওয়া যাচ্ছে না।",
    "Telegram delivery failed. Please try again.": "Telegram-এ পাঠানো যায়নি। আবার চেষ্টা করুন।",
    "A response has already been submitted for this case.": "এই কেসের জন্য ইতিমধ্যে উত্তর জমা দেওয়া হয়েছে।",
    "The response could not be saved.": "উত্তরটি সংরক্ষণ করা যায়নি।",
    "The response could not be completed.": "উত্তরটি সম্পন্ন করা যায়নি।",
    "The case response configuration could not be loaded.": "কেসের উত্তর কনফিগারেশন লোড করা যায়নি।",
    "The Telegram destination could not be loaded.": "Telegram গন্তব্য লোড করা যায়নি।",
    "No active response route is configured for this shop group.": "এই শপ গ্রুপের জন্য সক্রিয় রেসপন্স রুট কনফিগার করা নেই।",
    "More than one response route matches this shop group.": "এই শপ গ্রুপের সঙ্গে একাধিক রেসপন্স রুট মিলেছে।",
    "Telegram accepted the response, but final status recording failed. Do not retry; contact an administrator.": "Telegram উত্তরটি গ্রহণ করেছে, কিন্তু চূড়ান্ত স্ট্যাটাস সংরক্ষণ হয়নি। আবার চেষ্টা না করে অ্যাডমিনের সঙ্গে যোগাযোগ করুন।"
  }
};

const valid = new Set(["en", "bn"]), saved = localStorage.getItem("ops-language");
let language = valid.has(saved) ? saved : "en";
const originalText = new WeakMap();
const t = (value) => language === "bn" ? translations.bn[value] || value : value;

function applyLanguage() {
  document.documentElement.lang = language === "bn" ? "bn" : "en";
  document.title = language === "bn" ? "অপারেশনস · Telegram Ops" : "Operations · Telegram Ops";
  for (const element of document.querySelectorAll("[data-en-text]")) element.textContent = t(element.dataset.enText);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName)) continue;
    if (node.parentElement?.closest("[data-en-text]")) continue;
    if (!originalText.has(node)) originalText.set(node,node.nodeValue);
    const source = originalText.get(node), trimmed = source.trim();
    if (trimmed) node.nodeValue = source.replace(trimmed,t(trimmed));
  }
  for (const element of document.querySelectorAll("[placeholder]")) {
    element.dataset.enPlaceholder ||= element.placeholder;
    element.placeholder = language === "bn" ? t(element.dataset.enPlaceholder) : element.dataset.enPlaceholder;
  }
  for (const button of document.querySelectorAll("[data-language]")) {
    const selected = button.dataset.language === language;
    button.classList.toggle("selected",selected); button.setAttribute("aria-pressed",String(selected));
  }
}

function setLanguage(value) {
  if (!valid.has(value) || value === language) return;
  language = value; localStorage.setItem("ops-language",language); applyLanguage();
}

window.opsI18n = { t, applyLanguage, setLanguage, getLanguage: () => language };
})();
