// Push notifications (20 Oct 2026): the pure half of @/lib/push. No database,
// no network, nothing sent.
//
//   npx tsx --tsconfig tsconfig.json scripts/verify-push.ts
//
// What it pins down:
//   1  isExpoPushToken: both Expo prefixes, nothing else, length cap
//   2  buildPushMessages: "<actor> <text>"; no actor -> capitalised text; text
//      that already names the actor is not prefixed twice; no message body
//      beyond the notification text; nobody without a token is sent anything
//   3  a SHOP's notification goes to its owner's token, titled with the shop
//   4  the data carries the notification's own fields for routing a tap
//   5  deadTokens: only DeviceNotRegistered tickets, matched by position

import { buildPushMessages, deadTokens, isExpoPushToken, type PushRow } from "../src/lib/push"

let fail = 0
let total = 0
function check(name: string, cond: boolean, detail = "") {
  total++
  if (!cond) {
    fail++
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`)
  }
}

const T1 = "ExponentPushToken[abcdefghij1234567890]"
const T2 = "ExpoPushToken[ZZZZZZZZZZ-_0987654321]"

// 1
check("token: Exponent prefix", isExpoPushToken(T1))
check("token: Expo prefix", isExpoPushToken(T2))
check("token: raw FCM refused", !isExpoPushToken("fcm:APA91bH-something"))
check("token: empty brackets refused", !isExpoPushToken("ExponentPushToken[]"))
check("token: too long refused", !isExpoPushToken(`ExponentPushToken[${"a".repeat(300)}]`))
check("token: not a string", !isExpoPushToken(42))

const row = (over: Partial<PushRow>): PushRow => ({
  id: "n1", type: "NEW_MESSAGE", message: "sent you a message", link: "/dashboard/messages?partner=u2",
  entityType: "conversation", entityId: "u2", userId: "u1", actorId: "u2", actorName: "Jamaica", ...over,
})
const tokens = new Map([["u1", T1], ["owner", T2]])
const noShops = new Map<string, { ownerId: string; name: string }>()

// 2
const [msg] = buildPushMessages([row({})], tokens, noShops)
check("actor + text", msg?.body === "Jamaica sent you a message", msg?.body)
check("title", msg?.title === "Baylo", msg?.title)
check("sent to the recipient", msg?.to === T1)
const sys = buildPushMessages([row({ actorId: null, actorName: null, message: "your ID was approved." })], tokens, noShops)[0]
check("no actor: capitalised", sys?.body === "Your ID was approved.", sys?.body)
const named = buildPushMessages([row({ message: 'Jamaica cancelled the trade for "Nicocola".' })], tokens, noShops)[0]
check("already names the actor: no double", named?.body === 'Jamaica cancelled the trade for "Nicocola".', named?.body)
check("no token: nothing", buildPushMessages([row({ userId: "nobody" })], tokens, noShops).length === 0)

// 3
const shops = new Map([["shopUser", { ownerId: "owner", name: "Lola's Kakanin" }]])
const shopMsg = buildPushMessages([row({ userId: "shopUser" })], tokens, shops)[0]
check("shop -> owner's phone", shopMsg?.to === T2)
check("shop name as title", shopMsg?.title === "Lola's Kakanin", shopMsg?.title)
check("shop without an owner token: nothing", buildPushMessages([row({ userId: "shopUser" })], new Map([["u1", T1]]), shops).length === 0)

// 4
check("data for routing", JSON.stringify(msg?.data) === JSON.stringify({
  notificationId: "n1", type: "NEW_MESSAGE", link: "/dashboard/messages?partner=u2",
  entityType: "conversation", entityId: "u2", actorId: "u2",
}), JSON.stringify(msg?.data))
check("android channel + sound", msg?.channelId === "alerts" && msg?.sound === "default" && msg?.priority === "high")

// 5
const two = buildPushMessages([row({}), row({ id: "n2", userId: "owner" })], tokens, noShops)
check("dead: by position", JSON.stringify(deadTokens(two, [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }])) === JSON.stringify([T2]))
check("dead: other errors kept", deadTokens(two, [{ status: "error", details: { error: "MessageRateExceeded" } }]).length === 0)
check("dead: junk answer", deadTokens(two, null).length === 0)

console.log(fail === 0 ? `verify-push: all ${total} checks passed` : `verify-push: ${fail} of ${total} FAILED`)
if (fail > 0) process.exitCode = 1
