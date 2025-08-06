import { db } from "~/server/db";
import { requests, users, chats, messages } from "~/server/db/schema";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import type { Message } from "ai";

const REQUESTS_PER_DAY = 1;

export async function checkRateLimit(userId: string): Promise<boolean> {
  // Check if user is admin
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (user?.isAdmin) {
    return true;
  }

  // Get start of current day in UTC
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  // Count requests made today
  const requestCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(requests)
    .where(
      and(eq(requests.userId, userId), gte(requests.timestamp, startOfDay)),
    );

  return (requestCount[0]?.count ?? 0) < REQUESTS_PER_DAY;
}

export async function recordRequest(userId: string) {
  await db.insert(requests).values({
    userId,
  });
}

export const upsertChat = async (opts: {
  userId: string;
  chatId: string;
  title: string;
  messages: Message[];
}) => {
  const { userId, chatId, title, messages: newMessages } = opts;

  // First, check if the chat exists and belongs to the user
  const existingChat = await db.query.chats.findFirst({
    where: eq(chats.id, chatId),
  });

  if (existingChat) {
    // If chat exists but belongs to a different user, throw error
    if (existingChat.userId !== userId) {
      throw new Error("Chat ID already exists under a different user");
    }
    // Delete all existing messages
    await db.delete(messages).where(eq(messages.chatId, chatId));
  } else {
    // Create new chat
    await db.insert(chats).values({
      id: chatId,
      userId,
      title,
    });
  }

  // Insert all messages
  await db.insert(messages).values(
    newMessages.map((message, index) => ({
      id: crypto.randomUUID(),
      chatId,
      role: message.role,
      parts: message.parts,
      order: index,
    })),
  );

  return { id: chatId };
};

export const getChat = async (opts: { userId: string; chatId: string }) => {
  const { userId, chatId } = opts;

  const chat = await db.query.chats.findFirst({
    where: and(eq(chats.id, chatId), eq(chats.userId, userId)),
    with: {
      messages: {
        orderBy: (messages, { asc }) => [asc(messages.order)],
      },
    },
  });

  if (!chat) {
    return null;
  }

  return {
    ...chat,
    messages: chat.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.parts,
    })),
  };
};

export const getChats = async (opts: { userId: string }) => {
  const { userId } = opts;

  return await db.query.chats.findMany({
    where: eq(chats.userId, userId),
    orderBy: (chats, { desc }) => [desc(chats.updatedAt)],
  });
};
