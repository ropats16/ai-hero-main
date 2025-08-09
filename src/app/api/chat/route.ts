import type { Message } from "ai";
import { z } from "zod";
import {
  streamText,
  createDataStreamResponse,
  appendResponseMessages,
} from "ai";
import { auth } from "~/server/auth";
import { model } from "~/models";
import { searchSerper } from "~/serper";
import { checkRateLimit, recordRequest, upsertChat } from "~/server/db/queries";
import { db } from "~/server/db";
import { chats } from "~/server/db/schema";
import { eq } from "drizzle-orm";

export const maxDuration = 60;

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    messages: Array<Message>;
    chatId?: string;
  };

  // Check rate limit
  const canMakeRequest = await checkRateLimit(session.user.id);
  if (!canMakeRequest) {
    return new Response("Rate limit exceeded", { status: 429 });
  }

  // Record the request
  await recordRequest(session.user.id);

  const { messages, chatId } = body;

  if (!messages.length) {
    return new Response("No messages provided", { status: 400 });
  }

  // If no chatId is provided, create a new chat with the user's message
  let currentChatId = chatId;
  let isNewChat = false;
  if (!currentChatId) {
    const newChatId = crypto.randomUUID();
    isNewChat = true;
    await upsertChat({
      userId: session.user.id,
      chatId: newChatId,
      title: messages[messages.length - 1]!.content.slice(0, 50) + "...",
      messages: messages, // Only save the user's message initially
    });
    currentChatId = newChatId;
  } else {
    // Verify the chat belongs to the user
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, currentChatId),
    });
    if (!chat || chat.userId !== session.user.id) {
      return new Response("Chat not found or unauthorized", { status: 404 });
    }
  }

  return createDataStreamResponse({
    execute: async (dataStream) => {
      if (isNewChat) {
        dataStream.writeData({
          type: "NEW_CHAT_CREATED",
          chatId: currentChatId,
        });
      }
      const result = streamText({
        model,
        messages,
        maxSteps: 10,
        system: `You are a helpful AI assistant with access to real-time web search capabilities. When answering questions:

1. Always search the web for up-to-date information when relevant
2. ALWAYS format URLs as markdown links using the format [title](url)
3. Be thorough but concise in your responses
4. If you're unsure about something, search the web to verify
5. When providing information, always include the source where you found it using markdown links
6. Never include raw URLs - always use markdown link format
7. When mentioning platforms, websites, or resources, always format them as markdown links
8. Integrate links naturally into your text rather than listing them separately

When you use the \`searchWeb\` tool, you will receive a list of search results formatted as a JSON array. Each result in the array will contain a title, a link, and a snippet. It is your responsibility to process this data and present it to the user in a readable format.

Here's how you should handle the search results:
- For each search result, you MUST create a markdown link by combining the title and the link. For example, if a result has the title "HyperBeam Docs" and the link "https://docs.hyperbeam.io", you must format it as "[HyperBeam Docs](https://docs.hyperbeam.io)".
- Use the snippet to understand the context of the search result and incorporate it into your answer naturally.
- Do not just list the links. Instead, weave them into your explanation to provide a seamless and informative response.

Remember to use the \`searchWeb\` tool whenever you need to find current information.`,
        tools: {
          searchWeb: {
            parameters: z.object({
              query: z.string().describe("The query to search the web for"),
            }),
            execute: async ({ query }, { abortSignal }) => {
              const results = await searchSerper(
                { q: query, num: 10 },
                abortSignal,
              );

              return results.organic.map((result) => ({
                title: result.title,
                link: result.link,
                snippet: result.snippet,
              }));
            },
          },
        },
        onFinish: async ({ response }) => {
          // Merge the existing messages with the response messages
          const updatedMessages = appendResponseMessages({
            messages,
            responseMessages: response.messages,
          });

          const lastMessage = messages[messages.length - 1];
          if (!lastMessage) {
            return;
          }

          // Save the complete chat history
          await upsertChat({
            userId: session.user.id,
            chatId: currentChatId,
            title: lastMessage.content.slice(0, 50) + "...",
            messages: updatedMessages,
          });
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError: (e) => {
      console.error(e);
      return "Oops, an error occured!";
    },
  });
}
