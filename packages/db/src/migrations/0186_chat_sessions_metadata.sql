-- Migration: Add metadata column to chat_sessions for LangGraph orchestrator context
ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "metadata" text;
