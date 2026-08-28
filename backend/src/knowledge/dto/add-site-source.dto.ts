import { IsString, MinLength } from 'class-validator';

export class AddSiteSourceDto {
  @IsString()
  @MinLength(3)
  url!: string;
}
