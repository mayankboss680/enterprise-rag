import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;

        if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
        if (file.type !== "application/pdf") return NextResponse.json({ error: "Only PDF files are allowed" }, { status: 400 });

        const fileBuffer = Buffer.from(await file.arrayBuffer());

        // Content-addressed dedup: identical bytes => identical SHA-256
        const contentHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

        const { data: existing } = await supabase
            .from("documents")
            .select("id, filename, status")
            .eq("content_hash", contentHash)
            .maybeSingle();

        if (existing) {
            return NextResponse.json(
                {
                    success: false,
                    error: `Duplicate: "${existing.filename}" is already in the knowledge base (status: ${existing.status}).`,
                },
                { status: 409 }
            );
        }

        const safeName = file.name.replace(/[^\w.-]+/g, "_");
        const storagePath = `${Date.now()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
            .from("pdf-documents")
            .upload(storagePath, fileBuffer, { contentType: "application/pdf", upsert: false });
        if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

        const { data: doc, error: dbError } = await supabase
            .from("documents")
            .insert({
                filename: file.name,
                storage_path: storagePath,
                status: "pending",
                content_hash: contentHash,
            })
            .select()
            .single();
        if (dbError) throw new Error(`DB insert failed: ${dbError.message}`);

        return NextResponse.json({
            success: true,
            documentId: doc.id,
            message: "Upload successful. Processing queued.",
        });
    } catch (error: any) {
        console.error("UPLOAD API ERROR:", error);
        return NextResponse.json({ error: error?.message || "Internal server error" }, { status: 500 });
    }
}