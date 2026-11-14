# Connect Lark or Feishu

Connect a Lark or Feishu app so a **Tag**, a persistent AI actor with its own responsibilities
and permissions, replies in group chats and direct bot chats. SuperTag's Lark collaboration surface
uses the official Node SDK and an outbound long connection, so SuperTag does not need a public
webhook endpoint for Lark message events.

A **collaboration surface** links SuperTag to an
external work tool. The **Gateway** is the part of the **Control Plane**, the SuperTag service, that
receives and sends collaboration surface traffic. Each request becomes a **Task**, one request
accepted for a Tag. See the [glossary](../reference/glossary.md) for other terms.

## Before you start

- Permission to create and publish an internal app in your Lark or Feishu tenant.
- The `supertag` CLI installed.

## 1. Create the app

Create an internal app in the console for your tenant:

- [Lark Developer Console](https://open.larksuite.com/app)
- [Feishu Developer Console](https://open.feishu.cn/app)

Enable the bot capability and add these tenant permissions:

```text
im:message:send_as_bot
im:message.p2p_msg:readonly
im:message.group_msg:readonly
im:chat:readonly
```

## 2. Subscribe to message events

Under event subscriptions, choose **long connection** and subscribe to:

```text
im.message.receive_v1
```

## 3. Publish and install the app

Publish the app and install it in the tenant. Add the bot to each group chat where a Tag should be
available.

## 4. Enroll the app

For Lark International:

```sh
export LARK_APP_ID="cli_..."
export LARK_APP_SECRET="..."
supertag setup surface lark --domain lark
```

For Feishu, use `--domain feishu`. Setup asks for the tenant key too, or reads `LARK_TENANT_KEY`.
It verifies the credentials through `bot/v3/info`, saves the App Secret in the credential vault,
and records the App ID, bot `open_id`, domain, and display name as the Surface Account in the
Control Plane and in `supertag.yaml`. The local Gateway then opens the long connection; Lark needs
no public URL.

## 5. Add a Tag to a chat

Find the stable `chat_id` (`oc_...`) through Lark's API Explorer or the
`GET /open-apis/im/v1/chats` API, then run:

```sh
supertag tag update lead --add-location lark --chat-id oc_0123456789
```

Add `--account NAME`, the Surface Account name from setup, when more than one Lark app is
connected.

## Check that it worked

In a group chat, mention `@SuperTag` and ask a question. In a direct bot chat, send the question
normally. SuperTag replies in the originating thread. Once a thread has invoked the Tag, later human
replies in that thread continue the same **Session**, the group of Tasks from one conversation,
without another mention.

## Rules

- The App ID and App Secret authorize only Gateway ingress and replies. They never reach a
  Worker Host or the Tag's agent. See [credential storage](../reference/credential-storage.md).
- Adding a Tag to a chat does not give the harness Lark tools. A **Worker Host**, the machine or
  sandbox that runs the Task, provides them with the `lark` MCP preset, and the Tag's
  **Permission Sets**, its allowed actions, grant them. See
  [MCP tools](worker-tools.md#lark--feishu).

## If something goes wrong

- Confirm the selected `--domain` matches the app's tenant.
- Confirm the app is published, installed, and present in the target group.
- Confirm `im.message.receive_v1` uses long-connection delivery.
- Confirm the bound `chat_id` begins with `oc_` and belongs to the connected app's tenant.
- Inspect the Gateway's log, `supertag logs -f gateway`, for long-connection errors.

For general checks, follow the [first-reply checklist](../guides/troubleshooting.md).

## Next

- [collaboration surface guides](README.md)
