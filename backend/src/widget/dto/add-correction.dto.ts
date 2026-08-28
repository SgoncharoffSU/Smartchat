import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AddCorrectionDto {
  @IsString()
  @MinLength(1)
  botToken!: string;

  // What the visitor said right before the bad reply — optional since the
  // owner may be flagging the very first (isInit/isReveal) turn, which has
  // no preceding visitor message at all.
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
  goodReply!: string;
}
