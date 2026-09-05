import { BadRequestException, Body, Controller, Get, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { ImplementationManagerService } from './implementation-manager.service';
import { SupportGuard } from '../auth/support.guard';
import { UPLOADS_DIR } from '../uploads-path';

// Photo only — narrower than KnowledgeController's own upload (which also
// allows PDF/Word for KB attachments), same reasoning: only ever a face
// photo here, never a document.
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTO_SIZE_BYTES = 5 * 1024 * 1024;

/** Superadmin-only (same support-admin.html panel as payment-settings/llm-providers) — one manager shown to every company today, see ImplementationManagerService's own comment. */
@Controller('api/admin/manager')
@UseGuards(SupportGuard)
export class ImplementationManagerAdminController {
  constructor(private readonly manager: ImplementationManagerService) {}

  @Get()
  get() {
    return this.manager.getForAdmin();
  }

  @Post()
  updateName(@Body() body: { name?: string }) {
    return this.manager.updateName(body?.name ?? '');
  }

  @Post('photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOADS_DIR,
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
      }),
      limits: { fileSize: MAX_PHOTO_SIZE_BYTES },
      fileFilter: (_req, file, cb) => cb(null, ALLOWED_IMAGE_TYPES.has(file.mimetype)),
    }),
  )
  async uploadPhoto(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Файл не получен — проверьте тип (JPEG, PNG, WebP) и размер (до 5 МБ)');
    const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'https://chat.glavinstrument.com';
    return this.manager.setPhoto(`${publicBaseUrl}/uploads/${file.filename}`);
  }
}
