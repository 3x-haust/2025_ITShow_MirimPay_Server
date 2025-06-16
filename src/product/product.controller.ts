import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ProductService } from './product.service';
import { CreateProductDto } from './dto/create-product.dto';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { PurchaseRequestDto } from './dto/purchase-request.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('products')
@ApiBearerAuth('access-token')
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateProductDto) {
    return this.productService.create(dto);
  }

  @Post('purchase')
  purchaseProducts(@Body() dto: PurchaseRequestDto) {
    return this.productService.processPurchase(dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  findAll() {
    return this.productService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productService.findOne(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.productService.remove(id);
  }
}
