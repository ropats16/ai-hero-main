import { db } from "~/server/db";
import { requests, users } from "~/server/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";

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
		.where(and(eq(requests.userId, userId), gte(requests.timestamp, startOfDay)));

	return (requestCount[0]?.count ?? 0) < REQUESTS_PER_DAY;
}

export async function recordRequest(userId: string) {
	await db.insert(requests).values({
		userId,
	});
}