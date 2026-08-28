import { Module } from '@nestjs/common';
import { SiteAnalysisService } from './site-analysis.service';

@Module({
  providers: [SiteAnalysisService],
  exports: [SiteAnalysisService],
})
export class SiteAnalysisModule {}
