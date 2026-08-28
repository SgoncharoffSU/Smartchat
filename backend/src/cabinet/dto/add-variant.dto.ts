import { IsString, MaxLength, MinLength } from 'class-validator';

export class AddVariantDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  text!: string;
}
