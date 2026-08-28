import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class PreviewCorrectionDto {
  @IsString()
  @MinLength(1)
  botToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  situationContext?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3000)
  badReply?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(3000)
  note!: string;
}
