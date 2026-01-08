export async function sendDM(slackApp: any, userId: string, text: string) {
  const im = await slackApp.client.conversations.open({ users: userId });
  const channelId = im?.channel?.id;
  if (!channelId) throw new Error("Failed to open IM: no channel id returned");
  await slackApp.client.chat.postMessage({
    channel: channelId,
    text,
  });
}
