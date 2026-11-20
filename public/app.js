// =====================================================================
// Expense Splitter: the page
// =====================================================================
// "/" is your list of groups. "/g/abc123" is the group whose secret code is abc123.
const groupMatch = location.pathname.match(/^\/g\/([A-Za-z0-9_-]+)\/?$/);
const groupCode = groupMatch ? groupMatch[1] : null;

// ---------- Data from the server ----------
let me = null;     // { id, name, username } of whoever is logged in
let state = null;  // the open group: group, members, expenses, payments, balances, settleUp
let authMode = "signup";
let refreshTimer = null;

// ---------- Page elements ----------
function byId(id) {
  return document.getElementById(id);
}

const views = {
  loading: byId("loadingView"),
  auth: byId("authView"),
  home: byId("homeView"),
  join: byId("joinView"),
  missing: byId("missingView"),
  group: byId("groupView"),
};

const addExpenseBtn = byId("addExpenseBtn");
const toast = byId("toast");

const AVATAR_COLORS = ["#cfe3da", "#f6dfa6", "#d9d6f2", "#f4cfc6", "#c9ddf0"];
const CROSS_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
  '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// =====================================================================
// Small helpers
// =====================================================================
// All money arrives from the server in cents: 30000 means $300.00
function money(cents) {
  return "$" + (cents / 100).toFixed(2);
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeAvatar(name, colorIndex, extraClass) {
  const avatar = makeElement("span", "avatar" + (extraClass ? " " + extraClass : ""));
  avatar.textContent = name.charAt(0).toUpperCase();
  avatar.style.background = AVATAR_COLORS[colorIndex % AVATAR_COLORS.length];
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function makeRemoveButton(label, onClick) {
  const button = makeElement("button", "icon-btn");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.innerHTML = CROSS_ICON;
  button.addEventListener("click", onClick);
  return button;
}

let toastTimer = null;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toast.classList.remove("show");
  }, 3500);
}

function showView(name) {
  for (const key in views) {
    views[key].hidden = key !== name;
  }
  addExpenseBtn.hidden = name !== "group";
  if (name !== "group") stopRefreshing();
}

function anyPanelOpen() {
  return document.querySelector("dialog[open]") !== null;
}

// =====================================================================
// Talking to the server
// =====================================================================
// Gives back { ok, status, data, error }. error is a message to show people.
async function api(method, address, body) {
  const options = { method: method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(address, options);
    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      // No JSON in the answer
    }

    // Logged out (or the login ran out): go to the sign-in screen
    if (response.status === 401 && data.needLogin) {
      me = null;
      showAuth();
    }

    return {
      ok: response.ok,
      status: response.status,
      data: data,
      error: response.ok ? null : data.error || "Something went wrong. Try again.",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {},
      error: "Can't reach the server. Check your connection, then try again.",
    };
  }
}

// =====================================================================
// Sign up and log in
// =====================================================================
const authForm = byId("authForm");
const authName = byId("authName");
const authUsername = byId("authUsername");
const authPassword = byId("authPassword");
const authError = byId("authError");

function showAuth() {
  showView("auth");
  const signup = authMode === "signup";

  byId("authTitle").textContent = signup ? "Create your profile" : "Welcome back";
  byId("authSub").textContent = groupCode
    ? "Then you can join the group your friend shared."
    : "Split costs with the people you live and travel with.";
  byId("nameField").hidden = !signup;
  byId("authHint").hidden = !signup;
  authPassword.autocomplete = signup ? "new-password" : "current-password";
  byId("authSubmit").textContent = signup ? "Create profile" : "Log in";
  byId("switchText").textContent = signup ? "Already have a profile?" : "New here?";
  byId("switchBtn").textContent = signup ? "Log in" : "Create a profile";
  authError.textContent = "";
}

byId("switchBtn").addEventListener("click", function () {
  authMode = authMode === "signup" ? "login" : "signup";
  showAuth();
  (authMode === "signup" ? authName : authUsername).focus();
});

authForm.addEventListener("submit", async function (event) {
  event.preventDefault(); // stop the browser reloading the page
  const signup = authMode === "signup";
  const name = authName.value.trim();
  const username = authUsername.value.trim();
  const password = authPassword.value;

  if (signup && name === "") {
    authError.textContent = "Enter your name.";
    authName.focus();
    return;
  }
  if (username === "") {
    authError.textContent = "Enter a username.";
    authUsername.focus();
    return;
  }
  if (password === "") {
    authError.textContent = "Enter a password.";
    authPassword.focus();
    return;
  }

  const result = signup
    ? await api("POST", "/api/signup", { name: name, username: username, password: password })
    : await api("POST", "/api/login", { username: username, password: password });

  if (!result.ok) {
    authError.textContent = result.error;
    return;
  }

  me = result.data.me;
  authPassword.value = "";
  showToast(signup ? "Welcome, " + me.name : "Logged in as " + me.name);
  openPage();
});

// =====================================================================
// Profile
// =====================================================================
const profileDialog = byId("profileDialog");

byId("profileBtn").addEventListener("click", function () {
  const avatar = byId("profileAvatar");
  avatar.textContent = me.name.charAt(0).toUpperCase();
  avatar.style.background = AVATAR_COLORS[me.id % AVATAR_COLORS.length];
  byId("profileName").textContent = me.name;
  byId("profileUsername").textContent = "@" + me.username;
  profileDialog.showModal();
});

byId("logoutBtn").addEventListener("click", async function () {
  await api("POST", "/api/logout", {});
  location.href = "/";
});

// =====================================================================
// Home: your groups
// =====================================================================
async function openHome() {
  // Ask for your groups and your friends at the same time
  const answers = await Promise.all([api("GET", "/api/groups"), loadFriends()]);
  const result = answers[0];
  if (!result.ok) {
    if (result.status !== 401) showToast(result.error);
    return;
  }
  me = result.data.me;
  renderHome(result.data.groups, result.data.directTotal || 0);
  renderFriends();
  showView("home");
}

function renderHome(groups, directTotal) {
  const profileBtn = byId("profileBtn");
  profileBtn.textContent = me.name.charAt(0).toUpperCase();
  profileBtn.style.background = AVATAR_COLORS[me.id % AVATAR_COLORS.length];

  // The dark panel: your total across every group and every friend
  let total = directTotal;
  for (const g of groups) total = total + g.myBalance;

  byId("overallTitle").textContent = "Hi, " + me.name;
  const message = byId("overallMessage");
  message.innerHTML = "";
  if (groups.length === 0 && friends.length === 0 && total === 0) {
    message.textContent = "Add a friend or make a group to start splitting.";
  } else if (total > 0) {
    message.append("You're owed ", makeElement("span", "amount", money(total)), " in total.");
  } else if (total < 0) {
    message.append("You owe ", makeElement("span", "amount", money(-total)), " in total.");
  } else {
    message.textContent = "You're all settled up.";
  }

  // The list of groups
  const list = byId("groupsList");
  list.innerHTML = "";
  if (groups.length === 0) {
    list.appendChild(makeElement("li", "empty", "No groups yet. Tap New group to make one."));
    return;
  }

  for (const g of groups) {
    const li = makeElement("li");
    const link = makeElement("a", "row group-link");
    link.href = "/g/" + g.code;

    const text = makeElement("span", "row-text");
    text.appendChild(makeElement("span", "row-title", g.name));
    if (g.myBalance > 0) {
      text.appendChild(makeElement("span", "row-sub gets", "You get back " + money(g.myBalance)));
    } else if (g.myBalance < 0) {
      text.appendChild(makeElement("span", "row-sub owes", "You owe " + money(-g.myBalance)));
    } else {
      const people = g.memberCount === 1 ? "Just you so far" : g.memberCount + " people, settled up";
      text.appendChild(makeElement("span", "row-sub", people));
    }

    link.appendChild(text);
    li.appendChild(link);
    list.appendChild(li);
  }
}

// New group panel
const groupDialog = byId("groupDialog");
const groupForm = byId("groupForm");
const groupNameInput = byId("groupNameInput");
const groupError = byId("groupError");

byId("newGroupBtn").addEventListener("click", function () {
  groupForm.reset();
  groupError.textContent = "";
  groupDialog.showModal();
  groupNameInput.focus();
});

groupForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  const name = groupNameInput.value.trim();
  if (name === "") {
    groupError.textContent = "Enter a group name.";
    groupNameInput.focus();
    return;
  }

  const result = await api("POST", "/api/groups", { name: name });
  if (!result.ok) {
    groupError.textContent = result.error;
    return;
  }
  location.href = "/g/" + result.data.code;
});

// =====================================================================
// Opening a group
// =====================================================================
function groupApi(rest) {
  return "/api/groups/" + groupCode + rest;
}

async function openGroup() {
  const result = await api("GET", groupApi(""));

  if (result.status === 404) {
    byId("missingMessage").textContent = result.error;
    showView("missing");
    return;
  }
  if (!result.ok) {
    if (result.status !== 401) showToast(result.error);
    return;
  }

  me = result.data.me;

  // Not in this group yet: offer to join
  if (result.data.preview) {
    showJoin(result.data.preview);
    return;
  }

  state = result.data;
  renderGroup();
  showView("group");
  startRefreshing();
}

function showJoin(preview) {
  byId("joinTitle").textContent = "Join " + preview.name;
  const names = preview.memberNames;
  let who = "";
  if (names.length === 1) who = names[0] + " is in this group.";
  else if (names.length === 2) who = names[0] + " and " + names[1] + " are in this group.";
  else if (names.length > 2) {
    who = names.slice(0, -1).join(", ") + " and " + names[names.length - 1] + " are in this group.";
  }
  byId("joinWho").textContent = who;
  byId("joinError").textContent = "";
  showView("join");
}

byId("joinBtn").addEventListener("click", async function () {
  const result = await api("POST", groupApi("/join"), {});
  if (!result.ok) {
    byId("joinError").textContent = result.error;
    return;
  }
  state = result.data;
  renderGroup();
  showView("group");
  startRefreshing();
  showToast("You joined " + state.group.name);
});

// Check for changes other people made, every 8 seconds while the page is open
async function refreshGroup() {
  if (!state || document.hidden || anyPanelOpen()) return;
  const result = await api("GET", groupApi(""));
  if (result.status === 404) {
    stopRefreshing();
    byId("missingMessage").textContent = result.error;
    showView("missing");
    return;
  }
  if (result.ok && result.data.group) {
    state = result.data;
    renderGroup();
  }
}

function startRefreshing() {
  stopRefreshing();
  refreshTimer = setInterval(refreshGroup, 8000);
}

function stopRefreshing() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

document.addEventListener("visibilitychange", function () {
  if (!document.hidden && refreshTimer) refreshGroup();
});

// =====================================================================
// Drawing a group
// =====================================================================
function memberById(userId) {
  for (const member of state.members) {
    if (member.id === userId) return member;
  }
  return { id: userId, name: "Someone" };
}

// "You" for yourself, the person's name for everyone else
function nameFor(userId) {
  return userId === me.id ? "You" : memberById(userId).name;
}

function lower(name) {
  return name === "You" ? "you" : name;
}

function balanceOf(userId) {
  for (const b of state.balances) {
    if (b.userId === userId) return b.cents;
  }
  return 0;
}

function renderGroup() {
  const direct = state.group.isDirect;
  byId("groupTitle").textContent = direct ? "You and " + state.group.name : state.group.name;
  document.title = state.group.name + " · Expense Splitter";
  byId("deleteGroupBtn").hidden = !state.group.isOwner;

  // Just you and one friend: nobody else to invite
  byId("shareBtn").hidden = direct;
  byId("addPeopleBtn").hidden = direct;
  for (const link of document.querySelectorAll(".back-link")) {
    link.textContent = direct ? "Home" : "Your groups";
  }

  renderSettleUp();
  renderPeople();
  renderActivity();
}

function renderSettleUp() {
  const body = byId("settleBody");
  body.innerHTML = "";

  if (state.expenses.length === 0 && state.payments.length === 0) {
    const text = state.members.length === 1
      ? "Invite your friends, then add your first expense."
      : "Nothing to settle yet. Add your first expense.";
    body.appendChild(makeElement("p", "settle-message", text));
    return;
  }

  if (state.settleUp.length === 0) {
    body.appendChild(makeElement("p", "settle-message", "Everyone is settled up."));
    return;
  }

  const list = makeElement("ul", "payments");
  for (const p of state.settleUp) {
    const from = nameFor(p.from);
    const to = lower(nameFor(p.to));
    const verb = from === "You" ? " pay " : " pays ";

    const li = makeElement("li");
    li.appendChild(makeElement("span", "payment-who", from + verb + to));
    li.appendChild(makeElement("span", "payment-amount", money(p.cents)));

    const button = makeElement("button", "mark-paid", "Record this payment");
    button.type = "button";
    button.addEventListener("click", function () {
      openPaymentDialog(p.from, p.to, p.cents);
    });
    li.appendChild(button);
    list.appendChild(li);
  }
  body.appendChild(list);
}

function renderPeople() {
  const list = byId("peopleList");
  list.innerHTML = "";

  for (const member of state.members) {
    const cents = balanceOf(member.id);
    const li = makeElement("li", "row");
    li.appendChild(makeAvatar(member.name, member.id));

    const text = makeElement("div", "row-text");
    const title = member.id === me.id ? member.name + " (you)" : member.name;
    text.appendChild(makeElement("span", "row-title", title));

    if (cents > 0) {
      text.appendChild(makeElement("span", "row-sub gets", "Gets back " + money(cents)));
    } else if (cents < 0) {
      text.appendChild(makeElement("span", "row-sub owes", "Owes " + money(-cents)));
    } else {
      text.appendChild(makeElement("span", "row-sub", "Settled up"));
    }
    li.appendChild(text);
    list.appendChild(li);
  }

  if (state.members.length === 1) {
    list.appendChild(makeElement("li", "empty", "Tap Add people to bring your friends in."));
  }
}

function renderActivity() {
  const list = byId("activityList");
  list.innerHTML = "";

  let spent = 0;
  for (const e of state.expenses) spent = spent + e.cents;
  byId("totalDisplay").textContent = state.expenses.length ? money(spent) + " spent" : "";

  // Expenses and payments together, newest first
  const items = [];
  for (const e of state.expenses) items.push({ kind: "expense", item: e });
  for (const p of state.payments) items.push({ kind: "payment", item: p });
  items.sort(function (a, b) {
    return b.item.createdAt - a.item.createdAt;
  });

  if (items.length === 0) {
    list.appendChild(makeElement("li", "empty", "No expenses yet."));
    return;
  }

  for (const entry of items) {
    list.appendChild(entry.kind === "expense" ? expenseRow(entry.item) : paymentRow(entry.item));
  }
}

function expenseRow(e) {
  const li = makeElement("li", "row");
  li.appendChild(makeAvatar(e.description, 1));

  const text = makeElement("div", "row-text");
  text.appendChild(makeElement("span", "row-title", e.description));

  const splitCount = e.shares.length;
  let split = splitCount === state.members.length ? "split between everyone" : "split between " + splitCount;
  if (state.group.isDirect) {
    split = splitCount === 2 ? "split equally" : "for " + lower(nameFor(e.shares[0].userId));
  }
  text.appendChild(makeElement("span", "row-sub", nameFor(e.paidBy) + " paid, " + split));

  // What this expense means for you
  let myShare = 0;
  for (const s of e.shares) {
    if (s.userId === me.id) myShare = s.cents;
  }
  if (e.paidBy === me.id) {
    const lent = e.cents - myShare;
    if (lent > 0) text.appendChild(makeElement("span", "row-sub gets", "You lent " + money(lent)));
  } else if (myShare > 0) {
    text.appendChild(makeElement("span", "row-sub owes", "You borrowed " + money(myShare)));
  } else {
    text.appendChild(makeElement("span", "row-sub", "Not part of your share"));
  }

  li.appendChild(text);
  li.appendChild(makeElement("span", "row-amount", money(e.cents)));
  li.appendChild(
    makeRemoveButton("Delete " + e.description, async function () {
      const sure = await askToConfirm(
        "Delete " + e.description + "?",
        "It's removed for everyone in the group, and balances change.",
        "Delete expense"
      );
      if (!sure) return;
      const result = await api("DELETE", groupApi("/expenses/" + e.id));
      if (result.ok) {
        state = result.data;
        renderGroup();
      }
      showToast(result.error || "Deleted " + e.description);
    })
  );
  return li;
}

function paymentRow(p) {
  const li = makeElement("li", "row");
  const icon = makeElement("span", "avatar payment", "✓");
  icon.setAttribute("aria-hidden", "true");
  li.appendChild(icon);

  const text = makeElement("div", "row-text");
  text.appendChild(makeElement("span", "row-title", nameFor(p.from) + " paid " + lower(nameFor(p.to))));
  text.appendChild(makeElement("span", "row-sub", "Payment"));
  li.appendChild(text);
  li.appendChild(makeElement("span", "row-amount", money(p.cents)));
  li.appendChild(
    makeRemoveButton("Delete payment", async function () {
      const sure = await askToConfirm(
        "Delete this payment?",
        "Only do this if it was recorded by mistake. Balances go back to before it.",
        "Delete payment"
      );
      if (!sure) return;
      const result = await api("DELETE", groupApi("/payments/" + p.id));
      if (result.ok) {
        state = result.data;
        renderGroup();
      }
      showToast(result.error || "Payment deleted");
    })
  );
  return li;
}

// =====================================================================
// Name buttons in panels
// =====================================================================
// type is "radio" (pick one) or "checkbox" (pick several)
function fillChoices(container, type, groupName, selectedIds) {
  container.innerHTML = "";
  for (const member of state.members) {
    const label = makeElement("label", "choice");
    const input = document.createElement("input");
    input.type = type;
    input.name = groupName;
    input.value = member.id;
    input.checked = selectedIds.includes(member.id);
    label.appendChild(input);
    label.appendChild(makeElement("span", "", member.id === me.id ? "You" : member.name));
    container.appendChild(label);
  }
}

function checkedIds(container) {
  const ids = [];
  for (const input of container.querySelectorAll("input:checked")) ids.push(Number(input.value));
  return ids;
}

function toCents(text) {
  const amount = parseFloat(text);
  if (isNaN(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

// =====================================================================
// Panel: add an expense
// =====================================================================
const expenseDialog = byId("expenseDialog");
const expenseForm = byId("expenseForm");
const descInput = byId("descInput");
const amountInput = byId("amountInput");
const payerChoices = byId("payerChoices");
const splitChoices = byId("splitChoices");
const splitNote = byId("splitNote");
const expenseError = byId("expenseError");

function updateSplitNote() {
  const count = checkedIds(splitChoices).length;
  const cents = toCents(amountInput.value);

  if (count === 0) {
    splitNote.textContent = "Choose at least one person to split it with.";
    return;
  }
  const people = count === 1 ? "1 person" : count + " people";
  if (cents === null) {
    splitNote.textContent = "Split equally between " + people + ".";
    return;
  }
  const each = Math.floor(cents / count);
  const exact = each * count === cents;
  splitNote.textContent =
    "Split equally between " + people + ": " + (exact ? "" : "about ") + money(each) + " each.";
}

function openExpenseDialog() {
  expenseForm.reset();
  expenseError.textContent = "";

  const everyone = [];
  for (const member of state.members) everyone.push(member.id);
  fillChoices(payerChoices, "radio", "payer", [me.id]);
  fillChoices(splitChoices, "checkbox", "split", everyone);
  updateSplitNote();

  expenseDialog.showModal();
  descInput.focus();
}

amountInput.addEventListener("input", updateSplitNote);
splitChoices.addEventListener("change", updateSplitNote);

expenseForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  const description = descInput.value.trim();
  const cents = toCents(amountInput.value);
  const paidBy = checkedIds(payerChoices)[0];
  const splitWith = checkedIds(splitChoices);

  if (description === "") {
    expenseError.textContent = "Enter what the expense was for.";
    descInput.focus();
    return;
  }
  if (cents === null) {
    expenseError.textContent = "Enter an amount above 0.";
    amountInput.focus();
    return;
  }
  if (paidBy === undefined) {
    expenseError.textContent = "Choose who paid.";
    return;
  }
  if (splitWith.length === 0) {
    expenseError.textContent = "Choose who to split it between.";
    return;
  }

  const result = await api("POST", groupApi("/expenses"), {
    description: description,
    amount: cents / 100,
    paidBy: paidBy,
    splitWith: splitWith,
  });
  if (!result.ok) {
    expenseError.textContent = result.error;
    return;
  }

  state = result.data;
  renderGroup();
  expenseDialog.close();
  showToast("Added " + description);
});

addExpenseBtn.addEventListener("click", function () {
  if (state.members.length === 1) {
    showToast("Invite your friends first, so there's someone to split with.");
  }
  openExpenseDialog();
});

// =====================================================================
// Panel: record a payment (settle up)
// =====================================================================
const paymentDialog = byId("paymentDialog");
const paymentForm = byId("paymentForm");
const fromChoices = byId("fromChoices");
const toChoices = byId("toChoices");
const paymentAmount = byId("paymentAmount");
const paymentError = byId("paymentError");

function openPaymentDialog(fromId, toId, cents) {
  if (state.members.length < 2) {
    showToast("Invite someone first. Payments are between two people.");
    return;
  }
  paymentForm.reset();
  paymentError.textContent = "";

  // Without a suggestion: you paid the first other person
  if (fromId === undefined) {
    fromId = me.id;
    for (const member of state.members) {
      if (member.id !== me.id) {
        toId = member.id;
        break;
      }
    }
  }

  fillChoices(fromChoices, "radio", "from", [fromId]);
  fillChoices(toChoices, "radio", "to", [toId]);
  if (cents) paymentAmount.value = (cents / 100).toFixed(2);

  paymentDialog.showModal();
  if (!cents) paymentAmount.focus();
}

byId("recordPaymentBtn").addEventListener("click", function () {
  openPaymentDialog();
});

paymentForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  const from = checkedIds(fromChoices)[0];
  const to = checkedIds(toChoices)[0];
  const cents = toCents(paymentAmount.value);

  if (from === undefined || to === undefined) {
    paymentError.textContent = "Choose who paid and who they paid.";
    return;
  }
  if (from === to) {
    paymentError.textContent = "Choose two different people.";
    return;
  }
  if (cents === null) {
    paymentError.textContent = "Enter an amount above 0.";
    paymentAmount.focus();
    return;
  }

  const result = await api("POST", groupApi("/payments"), {
    from: from,
    to: to,
    amount: cents / 100,
  });
  if (!result.ok) {
    paymentError.textContent = result.error;
    return;
  }

  state = result.data;
  renderGroup();
  paymentDialog.close();
  showToast("Payment recorded");
});

// =====================================================================
// Inviting people and deleting the group
// =====================================================================
async function inviteFriends() {
  const link = location.origin + "/g/" + state.group.code;

  // On a phone (over https) this opens the share menu: WhatsApp and so on
  if (navigator.share) {
    try {
      await navigator.share({
        title: state.group.name,
        text: "Join \"" + state.group.name + "\" on Expense Splitter:",
        url: link,
      });
    } catch (error) {
      // The person closed the share menu. Nothing to do.
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(link);
    showToast("Link copied. Paste it in WhatsApp.");
  } catch (error) {
    showToast("Copy this link: " + link);
  }
}

byId("shareBtn").addEventListener("click", inviteFriends);

byId("deleteGroupBtn").addEventListener("click", async function () {
  const sure = await askToConfirm(
    "Delete " + state.group.name + "?",
    "This deletes the group and every expense and payment in it, for everyone. You can't undo it.",
    "Delete group"
  );
  if (!sure) return;

  const result = await api("DELETE", groupApi(""));
  if (!result.ok) {
    showToast(result.error);
    return;
  }
  location.href = "/";
});

// =====================================================================
// Friends and finding people
// =====================================================================
let friends = []; // [{ id, name, username }]

// A row with someone's initial, name and @username
function personRow(person) {
  const li = makeElement("li", "row");
  li.appendChild(makeAvatar(person.name, person.id));
  const text = makeElement("div", "row-text");
  text.appendChild(makeElement("span", "row-title", person.name));
  text.appendChild(makeElement("span", "row-sub", "@" + person.username));
  li.appendChild(text);
  return li;
}

function pillButton(label, onClick) {
  const button = makeElement("button", "pill-btn", label);
  button.type = "button";
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function doneButton(label) {
  const button = pillButton(label);
  button.disabled = true;
  return button;
}

function emptyItem(text) {
  return makeElement("li", "empty", text);
}

async function loadFriends() {
  const result = await api("GET", "/api/friends");
  if (result.ok) friends = result.data.friends;
  return result;
}

function renderFriends() {
  const list = byId("friendsList");
  list.innerHTML = "";

  if (friends.length === 0) {
    list.appendChild(emptyItem("No friends yet. Tap Find people to search by username."));
    return;
  }

  for (const friend of friends) {
    const li = makeElement("li", "row");

    // Tapping a friend opens the page for expenses with just them
    const open = makeElement("button", "friend-link");
    open.type = "button";
    open.setAttribute("aria-label", "Expenses with " + friend.name);
    open.appendChild(makeAvatar(friend.name, friend.id));
    const text = makeElement("span", "row-text");
    text.appendChild(makeElement("span", "row-title", friend.name));
    if (friend.balance > 0) {
      text.appendChild(makeElement("span", "row-sub gets", "Owes you " + money(friend.balance)));
    } else if (friend.balance < 0) {
      text.appendChild(makeElement("span", "row-sub owes", "You owe " + money(-friend.balance)));
    } else {
      text.appendChild(makeElement("span", "row-sub", "@" + friend.username));
    }
    open.appendChild(text);
    open.addEventListener("click", function () {
      openWithFriend(friend);
    });
    li.appendChild(open);

    li.appendChild(
      makeRemoveButton("Remove " + friend.name + " as a friend", async function () {
        const sure = await askToConfirm(
          "Remove " + friend.name + "?",
          "You'll stop being friends. You both stay in any groups you share, " +
            "and expenses between you two are kept if you add each other again.",
          "Remove friend"
        );
        if (!sure) return;
        const result = await api("DELETE", "/api/friends/" + friend.id);
        if (result.ok) {
          friends = result.data.friends;
          renderFriends();
        }
        showToast(result.error || "Removed " + friend.name);
      })
    );
    list.appendChild(li);
  }
}

async function openWithFriend(friend) {
  const result = await api("POST", "/api/friends/" + friend.id + "/direct", {});
  if (!result.ok) {
    showToast(result.error);
    return;
  }
  location.href = "/g/" + result.data.code;
}

function isInGroup(userId) {
  for (const member of state.members) {
    if (member.id === userId) return true;
  }
  return false;
}

// Adds someone to the open group, making them your friend first if needed.
// Gives back null when it worked, or an error message.
async function addToGroup(person, alreadyFriends) {
  if (!alreadyFriends) {
    const friendResult = await api("POST", "/api/friends", { userId: person.id });
    if (!friendResult.ok) return friendResult.error;
    friends = friendResult.data.friends;
  }
  const result = await api("POST", groupApi("/members"), { userId: person.id });
  if (!result.ok) return result.error;
  state = result.data;
  renderGroup();
  return null;
}

// ---------- Panel: find people by username ----------
const searchDialog = byId("searchDialog");
const searchInput = byId("searchInput");
const searchResults = byId("searchResults");
const searchError = byId("searchError");
let searchFromGroup = false; // true when opened from a group's "Add people"
let searchTimer = null;
let latestSearch = 0;

function showSearchMessage(text) {
  searchResults.innerHTML = "";
  searchResults.appendChild(emptyItem(text));
}

function openSearch(fromGroup) {
  searchFromGroup = fromGroup;
  byId("searchForm").reset();
  searchError.textContent = "";
  showSearchMessage("Type at least 2 letters of their username.");
  searchDialog.showModal();
  searchInput.focus();
}

// Search a moment after typing stops, not on every key
searchInput.addEventListener("input", function () {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});

byId("searchForm").addEventListener("submit", function (event) {
  event.preventDefault();
  clearTimeout(searchTimer);
  runSearch();
});

async function runSearch() {
  const text = searchInput.value.trim().replace(/^@/, "");
  searchError.textContent = "";
  if (text.length < 2) {
    showSearchMessage("Type at least 2 letters of their username.");
    return;
  }

  latestSearch = latestSearch + 1;
  const thisSearch = latestSearch;
  const result = await api("GET", "/api/users?q=" + encodeURIComponent(text));
  if (thisSearch !== latestSearch) return; // a newer search has started since

  if (!result.ok) {
    showSearchMessage(result.error);
    return;
  }
  if (result.data.users.length === 0) {
    showSearchMessage(
      "No username starts with \"" + text + "\". Check the spelling, or send them the invite link."
    );
    return;
  }

  searchResults.innerHTML = "";
  for (const user of result.data.users) {
    const li = personRow(user);
    li.appendChild(searchButton(user));
    searchResults.appendChild(li);
  }
}

function searchButton(user) {
  // Opened from a group: add straight to the group
  if (searchFromGroup) {
    if (isInGroup(user.id)) return doneButton("In group");
    const button = pillButton("Add to group", async function () {
      button.disabled = true;
      const error = await addToGroup(user, user.isFriend);
      if (error) {
        button.disabled = false;
        searchError.textContent = error;
        return;
      }
      button.textContent = "Added";
    });
    return button;
  }

  // Opened from the home page: add as a friend
  if (user.isFriend) return doneButton("Friends");
  const button = pillButton("Add friend", async function () {
    button.disabled = true;
    const result = await api("POST", "/api/friends", { userId: user.id });
    if (!result.ok) {
      button.disabled = false;
      searchError.textContent = result.error;
      return;
    }
    friends = result.data.friends;
    renderFriends();
    button.textContent = "Added";
  });
  return button;
}

byId("findPeopleBtn").addEventListener("click", function () {
  openSearch(false);
});

// ---------- Panel: add people to the open group ----------
const addPeopleDialog = byId("addPeopleDialog");
const addPeopleList = byId("addPeopleList");
const addPeopleError = byId("addPeopleError");

async function openAddPeople() {
  addPeopleError.textContent = "";
  addPeopleList.innerHTML = "";
  addPeopleList.appendChild(emptyItem("Loading your friends…"));
  addPeopleDialog.showModal();

  const result = await loadFriends();
  addPeopleList.innerHTML = "";
  if (!result.ok) {
    addPeopleList.appendChild(emptyItem(result.error));
    return;
  }

  const notInGroup = [];
  for (const friend of friends) {
    if (!isInGroup(friend.id)) notInGroup.push(friend);
  }

  if (friends.length === 0) {
    addPeopleList.appendChild(emptyItem("You haven't added any friends yet."));
    return;
  }
  if (notInGroup.length === 0) {
    addPeopleList.appendChild(emptyItem("All your friends are already in this group."));
    return;
  }

  for (const friend of notInGroup) {
    const li = personRow(friend);
    const button = pillButton("Add", async function () {
      button.disabled = true;
      const error = await addToGroup(friend, true);
      if (error) {
        button.disabled = false;
        addPeopleError.textContent = error;
        return;
      }
      button.textContent = "Added";
    });
    li.appendChild(button);
    addPeopleList.appendChild(li);
  }
}

byId("addPeopleBtn").addEventListener("click", openAddPeople);

byId("addPeopleFindBtn").addEventListener("click", function () {
  addPeopleDialog.close();
  openSearch(true);
});

byId("addPeopleLinkBtn").addEventListener("click", function () {
  addPeopleDialog.close();
  inviteFriends();
});

// =====================================================================
// Panel: "Are you sure?"
// =====================================================================
const confirmDialog = byId("confirmDialog");

// Opens the panel and waits. Gives back true if the person confirmed.
function askToConfirm(title, text, buttonText) {
  return new Promise(function (resolve) {
    byId("confirmTitle").textContent = title;
    byId("confirmText").textContent = text;
    byId("confirmOk").textContent = buttonText;
    confirmDialog.returnValue = "";
    confirmDialog.showModal();
    confirmDialog.addEventListener(
      "close",
      function () {
        resolve(confirmDialog.returnValue === "yes");
      },
      { once: true }
    );
  });
}

// Any button with data-close closes the panel it is in
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", function () {
    button.closest("dialog").close();
  });
}

// Tapping the dark area outside a panel closes it too
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close();
  });
}

// =====================================================================
// Start
// =====================================================================
function openPage() {
  if (groupCode) openGroup();
  else openHome();
}

async function start() {
  const result = await api("GET", "/api/me");
  if (result.ok) {
    me = result.data.me;
    openPage();
    return;
  }
  if (result.status === 0) {
    views.loading.firstElementChild.textContent = result.error;
  }
  // A 401 already showed the sign-up screen
}

start();

// Lets phones install the app and open it with a bad connection (see sw.js).
// Only works on https or localhost, so on your home Wi-Fi it quietly does nothing.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(function () {});
}
