import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { DislikesService } from './dislikes.service';
import { AuthGuard } from '../auth/auth.guard';

interface AuthedRequest extends Request {
  companyId: string;
}

@Controller('api/cabinet/dislikes')
@UseGuards(AuthGuard)
export class DislikesController {
  constructor(private readonly dislikes: DislikesService) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.dislikes.list(req.companyId, botId);
  }

  @Post(':messageId/resolve')
  resolve(@Req() req: AuthedRequest, @Param('messageId') messageId: string, @Body() body: { note: string }) {
    return this.dislikes.resolve(req.companyId, messageId, body.note ?? '');
  }

  @Post(':messageId/mark')
  mark(@Req() req: AuthedRequest, @Param('messageId') messageId: string) {
    return this.dislikes.markDisliked(req.companyId, messageId);
  }

  @Post(':messageId/preview')
  preview(@Req() req: AuthedRequest, @Param('messageId') messageId: string, @Body() body: { note: string }) {
    return this.dislikes.preview(req.companyId, messageId, body.note ?? '');
  }
}
