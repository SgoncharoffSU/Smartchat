import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { KnowledgeModerationStatus } from '@prisma/client';
import { Request } from 'express';
import { KnowledgeService } from './knowledge.service';
import { AuthGuard } from '../auth/auth.guard';
import { AddSiteSourceDto } from './dto/add-site-source.dto';
import { AddBulkTextDto } from './dto/add-bulk-text.dto';
import { UPLOADS_DIR } from '../uploads-path';

interface AuthedRequest extends Request {
  companyId: string;
}

// Deliberately narrow: exactly the kinds an owner would attach to a KB entry
// (contracts as PDF/Word, product photos) — never anything executable.
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

@Controller('api/cabinet/knowledge')
@UseGuards(AuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.knowledge.list(req.companyId, botId);
  }

  @Get('categories')
  listCategories(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.knowledge.listCategories(req.companyId, botId);
  }

  @Post('categories')
  createCategory(@Req() req: AuthedRequest, @Body() body: { name: string }, @Query('botId') botId?: string) {
    return this.knowledge.createCategory(req.companyId, body.name, botId);
  }

  @Delete('categories/:id')
  deleteCategory(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.knowledge.deleteCategory(req.companyId, id);
  }

  @Get('search')
  search(@Req() req: AuthedRequest, @Query('q') q: string, @Query('botId') botId?: string) {
    return this.knowledge.searchForCabinet(req.companyId, q ?? '', undefined, botId);
  }

  @Post('article')
  createArticle(
    @Req() req: AuthedRequest,
    @Body() body: { title: string; body: string; categoryId?: string | null },
    @Query('botId') botId?: string,
  ) {
    return this.knowledge.createArticle(req.companyId, body.title, body.body, body.categoryId, botId);
  }

  // Owner attaches a file (contract, product photo, spec sheet) to the
  // knowledge base — see KnowledgeService.createFileEntry's own comment on
  // why `description` (not the filename) is what actually gets matched
  // against a visitor's question.
  @Post('file')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOADS_DIR,
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
      }),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => cb(null, ALLOWED_MIME_TYPES.has(file.mimetype)),
    }),
  )
  async uploadFile(
    @Req() req: AuthedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { title: string; description?: string; categoryId?: string | null },
    @Query('botId') botId?: string,
  ) {
    if (!file) throw new BadRequestException('Файл не получен — проверьте тип и размер (до 15 МБ, PDF/Word/изображение)');
    const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'https://chat.glavinstrument.com';
    const fileUrl = `${publicBaseUrl}/uploads/${file.filename}`;
    return this.knowledge.createFileEntry(
      req.companyId,
      body.title,
      body.description ?? '',
      fileUrl,
      file.originalname,
      file.mimetype,
      body.categoryId,
      botId,
    );
  }

  @Post('bulk')
  createFromBulkText(@Body() dto: AddBulkTextDto, @Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.knowledge.createFromBulkText(req.companyId, dto.text, undefined, botId);
  }

  @Post('site')
  addFromSite(@Body() dto: AddSiteSourceDto, @Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.knowledge.addFromSite(req.companyId, dto.url, botId);
  }

  @Post('instruction')
  createInstruction(@Req() req: AuthedRequest, @Body() body: { text: string }, @Query('botId') botId?: string) {
    return this.knowledge.createInstruction(req.companyId, body.text, botId);
  }

  @Get('usage')
  getUsage(@Req() req: AuthedRequest, @Query('period') period?: string, @Query('botId') botId?: string) {
    const days = period === 'month' ? 30 : period === 'all' ? null : 7;
    const since = days ? new Date(Date.now() - days * 86400000) : undefined;
    return this.knowledge.getUsageSummary(req.companyId, since, botId);
  }

  @Patch(':id')
  update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { question?: string | null; answer?: string; categoryId?: string | null },
  ) {
    return this.knowledge.updateEntry(req.companyId, id, body);
  }

  @Post(':id/moderate')
  moderate(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { status: KnowledgeModerationStatus }) {
    return this.knowledge.setModerationStatus(req.companyId, id, body.status);
  }

  @Delete(':id')
  delete(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.knowledge.delete(req.companyId, id);
  }
}
