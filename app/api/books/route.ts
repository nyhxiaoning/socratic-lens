import { NextResponse } from "next/server";
import { listBooks } from "@/lib/book";

export const runtime = "nodejs";

export async function GET() {
  const books = await listBooks();
  return NextResponse.json({ books });
}
