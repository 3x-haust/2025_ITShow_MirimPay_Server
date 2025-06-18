import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { User } from './entities/user.entity';
import { Card } from './entities/card.entity';
import {
  Payment,
  PaymentStatus,
  PaymentMethod,
} from './entities/payment.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { RegisterCardDto } from './dto/register-card.dto';
import {
  CreateQrPaymentDto,
  ProcessPaymentDto,
  FacePaymentDto,
} from './dto/payment.dto';
import { NotFoundException } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as bcrypt from 'bcrypt';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  TossCardResponse,
  TossPaymentResponse,
  TossErrorResponse,
} from './interfaces/toss.interface';
import { EncryptionUtil } from '../utils/encryption.util';

const execAsync = promisify(exec);

interface UploadedFile {
  buffer?: Buffer;
  path?: string;
  originalname: string;
  mimetype: string;
  size: number;
  fieldname: string;
  encoding: string;
  destination?: string;
  filename?: string;
}

@Injectable()
export class UserService {
  private readonly TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
  private readonly TOSS_API_URL = 'https://api.tosspayments.com/v1';

  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Card)
    private cardRepo: Repository<Card>,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
  ) {}

  async create(dto: CreateUserDto) {
    const hashedPin = await bcrypt.hash(dto.pin, 10);
    const user = this.userRepo.create({
      ...dto,
      pin: hashedPin,
    });
    return this.userRepo.save(user);
  }

  findAll() {
    return this.userRepo.find();
  }

  async findOne(id: number) {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`${id}번 사용자를 찾을 수 없습니다.`);
    }
    return user;
  }

  async registerFace(userId: number, imageFile: UploadedFile) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    if (!imageFile) {
      throw new BadRequestException('이미지 파일이 제공되지 않았습니다.');
    }

    const uploadsDir = path.join(process.cwd(), 'uploads', 'faces');
    await fs.ensureDir(uploadsDir);

    const filename = `user_${userId}_${Date.now()}.jpg`;
    const imagePath = path.join(uploadsDir, filename);

    if (imageFile.path) {
      await fs.copy(imageFile.path, imagePath);
    } else if (imageFile.buffer) {
      await fs.writeFile(imagePath, imageFile.buffer);
    } else {
      throw new BadRequestException(
        '이미지 파일이 유효하지 않습니다. buffer 또는 path가 필요합니다.',
      );
    }

    try {
      const pythonScript = path.join(process.cwd(), 'public', 'face_api.py');
      const command = `python3 "${pythonScript}" register "${imagePath}" ${userId}`;
      const { stdout } = await execAsync(command);
      const result = JSON.parse(stdout) as {
        success: boolean;
        message: string;
        encoding?: string;
        error_code?: number;
      };

      if (result.success && result.encoding) {
        user.faceImagePath = imagePath;
        user.faceEncoding = result.encoding;
        await this.userRepo.save(user);

        return {
          success: true,
          message: '얼굴 등록이 완료되었습니다.',
          userId: userId,
        };
      } else {
        if (result.error_code === 404) {
          throw new NotFoundException(result.message);
        } else if (result.error_code === 400) {
          throw new BadRequestException(result.message);
        } else if (result.error_code === 500) {
          throw new InternalServerErrorException(result.message);
        } else {
          throw new Error(result.message);
        }
      }
    } catch (error: unknown) {
      await fs.remove(imagePath);

      if (error instanceof NotFoundException) {
        throw error;
      } else if (error instanceof BadRequestException) {
        throw error;
      } else if (error instanceof InternalServerErrorException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `얼굴 등록 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async recognizeFace(imageFile: UploadedFile) {
    if (!imageFile) {
      throw new BadRequestException('이미지 파일이 제공되지 않았습니다.');
    }

    const tempDir = path.join(process.cwd(), 'uploads', 'temp');
    await fs.ensureDir(tempDir);

    const filename = `temp_${Date.now()}.jpg`;
    const imagePath = path.join(tempDir, filename);

    if (imageFile.path) {
      await fs.copy(imageFile.path, imagePath);
    } else if (imageFile.buffer) {
      await fs.writeFile(imagePath, imageFile.buffer);
    } else {
      throw new BadRequestException(
        '이미지 파일이 유효하지 않습니다. buffer 또는 path가 필요합니다.',
      );
    }

    try {
      const users = await this.userRepo.find({
        where: { faceEncoding: Not(IsNull()) },
      });

      if (users.length === 0) {
        throw new NotFoundException('등록된 얼굴이 없습니다.');
      }

      const faceData = users.map((user) => ({
        userId: user.id,
        encoding: user.faceEncoding,
      }));

      const pythonScript = path.join(process.cwd(), 'public', 'face_api.py');
      const command = `python3 "${pythonScript}" recognize "${imagePath}" '${JSON.stringify(faceData)}'`;

      const { stdout } = await execAsync(command);
      const result = JSON.parse(stdout) as {
        success: boolean;
        message: string;
        userId?: number;
        confidence?: number;
        error_code?: number;
      };

      await fs.remove(imagePath);

      if (result.success && result.userId) {
        const recognizedUser = await this.userRepo.findOne({
          where: { id: result.userId },
        });

        return {
          success: true,
          message: '얼굴 인식 성공',
          user: recognizedUser,
          confidence: result.confidence,
        };
      } else {
        if (result.error_code === 404) {
          throw new NotFoundException(result.message);
        } else if (result.error_code === 400) {
          throw new BadRequestException(result.message);
        } else if (result.error_code === 500) {
          throw new InternalServerErrorException(result.message);
        } else {
          throw new Error(result.message);
        }
      }
    } catch (error: unknown) {
      await fs.remove(imagePath);

      if (error instanceof NotFoundException) {
        throw error;
      } else if (error instanceof BadRequestException) {
        throw error;
      } else if (error instanceof InternalServerErrorException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `얼굴 인식 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async registerCard(dto: RegisterCardDto, userId?: number) {
    if (!userId) {
      throw new BadRequestException('사용자 ID가 필요합니다.');
    }

    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['cards'],
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    try {
      const response = await axios.post<TossCardResponse>(
        `${this.TOSS_API_URL}/billing/authorizations/card`,
        {
          cardNumber: dto.cardNumber,
          cardExpirationYear: dto.expiryYear,
          cardExpirationMonth: dto.expiryMonth,
          cardPassword: dto.cardPassword.substring(0, 2),
          customerIdentityNumber: dto.identityNumber,
          cvc: dto.cvc,
          customerKey: `CUSTOMER_${uuidv4().substring(0, 8)}`,
        },
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${this.TOSS_SECRET_KEY}:`,
            ).toString('base64')}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (dto.isMainCard || user.cards.length === 0) {
        await this.cardRepo.update(
          { userId: userId, isMainCard: true },
          { isMainCard: false },
        );
      }

      const cardData = response.data;
      const card = this.cardRepo.create({
        userId: userId,
        billingKey: EncryptionUtil.encryptBillingKey(cardData.billingKey),
        customerKey: cardData.customerKey,
        cardCompany: cardData.cardCompany,
        cardNumber: `${cardData.card.number.substring(0, 4)}-****-****-${cardData.card.number.substring(12)}`,
        cardNickname: dto.cardNickname || `${cardData.cardCompany} 카드`,
        isMainCard: dto.isMainCard || user.cards.length === 0,
      });

      const savedCard = await this.cardRepo.save(card);

      return {
        success: true,
        message: '카드가 성공적으로 등록되었습니다.',
        card: {
          id: savedCard.id,
          cardCompany: savedCard.cardCompany,
          cardNumber: savedCard.cardNumber,
          cardNickname: savedCard.cardNickname,
          isMainCard: savedCard.isMainCard,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      } else if (error instanceof BadRequestException) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data as TossErrorResponse;
        const errorMessage =
          errorData?.message || '카드 등록 중 오류가 발생했습니다.';
        console.error('카드 등록 오류:', error.response?.data || error.message);
        throw new InternalServerErrorException(errorMessage);
      }

      throw new InternalServerErrorException(
        '카드 등록 중 오류가 발생했습니다.',
      );
    }
  }

  async getUserCards(userId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['cards'],
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    return user.cards.map((card) => ({
      id: card.id,
      billingKey: card.billingKey,
      customerKey: card.customerKey,
      cardCompany: card.cardCompany,
      cardNumber: card.cardNumber,
      cardNickname: card.cardNickname,
      isMainCard: card.isMainCard,
      createdAt: card.createdAt,
    }));
  }

  async setMainCard(userId: number, cardId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['cards'],
    });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }
    const card = await this.cardRepo.findOne({
      where: { id: cardId, userId },
    });
    if (!card) {
      throw new NotFoundException('카드를 찾을 수 없습니다.');
    }
    await this.cardRepo.update(
      { userId, isMainCard: true },
      { isMainCard: false },
    );

    card.isMainCard = true;
    await this.cardRepo.save(card);
    return {
      success: true,
      message: '메인 카드가 성공적으로 변경되었습니다.',
      card: card,
    };
  }

  async deleteCard(userId: number, cardId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['cards'],
    });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    const card = await this.cardRepo.findOne({
      where: { id: cardId, userId },
    });
    if (!card) {
      throw new NotFoundException('카드를 찾을 수 없습니다.');
    }

    const wasMainCard = card.isMainCard;
    await this.cardRepo.remove(card);

    if (wasMainCard) {
      const remainingCards = await this.cardRepo.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      });

      if (remainingCards.length > 0) {
        remainingCards[0].isMainCard = true;
        await this.cardRepo.save(remainingCards[0]);
      }
    }

    return {
      success: true,
      message: '카드가 성공적으로 삭제되었습니다.',
    };
  }

  async createQrPayment(dto: CreateQrPaymentDto) {
    const orderId = `ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const paymentData = {
      orderId,
      amount: dto.amount,
      orderName: dto.orderName,
      timestamp: Date.now(),
    };

    const payment = this.paymentRepo.create({
      orderId,
      amount: dto.amount,
      orderName: dto.orderName,
      paymentMethod: PaymentMethod.QR,
      status: PaymentStatus.PENDING,
    });

    await this.paymentRepo.save(payment);

    return {
      success: true,
      paymentData,
    };
  }

  async processPayment(dto: ProcessPaymentDto, userId?: number) {
    try {
      const user = await this.userRepo.findOne({
        where: { id: userId },
        relations: ['cards'],
      });

      if (!user) {
        throw new NotFoundException('사용자를 찾을 수 없습니다.');
      }

      const isMatch = await bcrypt.compare(dto.pin, user.pin);
      if (!isMatch) {
        throw new BadRequestException('PIN이 일치하지 않습니다.');
      }

      const card = user.cards.find((c) => c.customerKey === dto.customerKey);

      if (!card) {
        throw new NotFoundException(
          '해당 customerKey로 등록된 카드를 찾을 수 없습니다.',
        );
      }

      const decryptedBillingKey = EncryptionUtil.decryptBillingKey(
        dto.billingKey,
      );

      const response = await axios.post<TossPaymentResponse>(
        `${this.TOSS_API_URL}/billing/${decryptedBillingKey}`,
        {
          customerKey: dto.customerKey,
          amount: dto.amount,
          orderId: dto.orderId,
          orderName: dto.orderName,
        },
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${this.TOSS_SECRET_KEY}:`,
            ).toString('base64')}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const paymentData = response.data;
      await this.paymentRepo.update(
        { orderId: dto.orderId },
        {
          status: PaymentStatus.SUCCESS,
          tossPaymentKey: paymentData.paymentKey,
          tossResponse: JSON.stringify(paymentData),
          userId: card.user.id,
          cardId: card.id,
        },
      );

      return {
        success: true,
        message: '결제가 완료되었습니다.',
        paymentResult: paymentData,
      };
    } catch (error) {
      await this.paymentRepo.update(
        { orderId: dto.orderId },
        { status: PaymentStatus.FAILED },
      );

      if (error instanceof NotFoundException) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data as TossErrorResponse;
        const errorMessage =
          errorData?.message || '결제 처리 중 오류가 발생했습니다.';
        console.error('결제 처리 오류:', error.response?.data || error.message);
        throw new InternalServerErrorException(`결제 실패: ${errorMessage}`);
      }
      throw new InternalServerErrorException(
        '결제 처리 중 시스템 오류가 발생했습니다.',
      );
    }
  }

  async faceRecognitionPayment(
    imageFile: Express.Multer.File,
    dto: FacePaymentDto,
  ) {
    const recognitionResult = await this.recognizeFace(imageFile);

    if (!recognitionResult.success || !recognitionResult.user) {
      throw new NotFoundException(
        '얼굴 인식에 실패했습니다. 등록된 사용자를 찾을 수 없습니다.',
      );
    }

    const user = recognitionResult.user;

    const isMatch = await bcrypt.compare(dto.pin, user.pin);
    if (!isMatch) {
      throw new BadRequestException('PIN이 일치하지 않습니다.');
    }

    const mainCard = await this.cardRepo.findOne({
      where: { userId: user.id, isMainCard: true },
    });

    if (!mainCard) {
      throw new NotFoundException(
        '등록된 메인 카드가 없습니다. 먼저 카드를 등록해주세요.',
      );
    }

    const orderId = `FACE_ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const payment = this.paymentRepo.create({
      orderId,
      amount: dto.amount,
      orderName: dto.orderName,
      paymentMethod: PaymentMethod.FACE,
      userId: user.id,
      cardId: mainCard.id,
      status: PaymentStatus.PENDING,
    });

    await this.paymentRepo.save(payment);

    try {
      const decryptedBillingKey = EncryptionUtil.decryptBillingKey(
        mainCard.billingKey,
      );

      const response = await axios.post<TossPaymentResponse>(
        `${this.TOSS_API_URL}/billing/${decryptedBillingKey}`,
        {
          customerKey: mainCard.customerKey,
          amount: dto.amount,
          orderId,
          orderName: dto.orderName,
        },
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${this.TOSS_SECRET_KEY}:`,
            ).toString('base64')}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const paymentData = response.data;

      await this.paymentRepo.update(
        { orderId },
        {
          status: PaymentStatus.SUCCESS,
          tossPaymentKey: paymentData.paymentKey,
          tossResponse: JSON.stringify(paymentData),
        },
      );

      return {
        success: true,
        message: '얼굴 인식 결제가 완료되었습니다.',
        orderId,
        user: {
          id: user.id,
          nickname: user.nickname,
        },
        card: {
          cardCompany: mainCard.cardCompany,
          cardNumber: mainCard.cardNumber,
        },
        payment: {
          amount: dto.amount,
          orderName: dto.orderName,
          paymentKey: paymentData.paymentKey,
        },
        confidence: recognitionResult.confidence,
      };
    } catch (error) {
      await this.paymentRepo.update(
        { orderId },
        { status: PaymentStatus.FAILED },
      );

      if (error instanceof NotFoundException) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data as TossErrorResponse;
        const errorMessage =
          errorData?.message || '결제 처리 중 오류가 발생했습니다.';
        console.error(
          '얼굴 인식 결제 오류:',
          error.response?.data || error.message,
        );
        throw new InternalServerErrorException(`결제 실패: ${errorMessage}`);
      }
      throw new InternalServerErrorException(
        '결제 처리 중 시스템 오류가 발생했습니다.',
      );
    }
  }

  async faceRecognitionPaymentBase64(base64Image: string, dto: FacePaymentDto) {
    const recognitionResult = await this.recognizeFaceBase64(base64Image);

    if (!recognitionResult.success || !recognitionResult.user) {
      throw new NotFoundException(
        '얼굴 인식에 실패했습니다. 등록된 사용자를 찾을 수 없습니다.',
      );
    }

    const user = recognitionResult.user;

    const isMatch = await bcrypt.compare(dto.pin, user.pin);
    if (!isMatch) {
      throw new BadRequestException('PIN이 일치하지 않습니다.');
    }

    const mainCard = await this.cardRepo.findOne({
      where: { userId: user.id, isMainCard: true },
    });

    if (!mainCard) {
      throw new NotFoundException(
        '등록된 메인 카드가 없습니다. 먼저 카드를 등록해주세요.',
      );
    }

    const orderId = `FACE_ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const payment = this.paymentRepo.create({
      orderId,
      amount: dto.amount,
      orderName: dto.orderName,
      paymentMethod: PaymentMethod.FACE,
      userId: user.id,
      cardId: mainCard.id,
      status: PaymentStatus.PENDING,
    });

    await this.paymentRepo.save(payment);

    try {
      const decryptedBillingKey = EncryptionUtil.decryptBillingKey(
        mainCard.billingKey,
      );

      const response = await axios.post<TossPaymentResponse>(
        `${this.TOSS_API_URL}/billing/${decryptedBillingKey}`,
        {
          customerKey: mainCard.customerKey,
          amount: dto.amount,
          orderId,
          orderName: dto.orderName,
        },
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${this.TOSS_SECRET_KEY}:`,
            ).toString('base64')}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const paymentData = response.data;

      await this.paymentRepo.update(
        { orderId },
        {
          status: PaymentStatus.SUCCESS,
          tossPaymentKey: paymentData.paymentKey,
          tossResponse: JSON.stringify(paymentData),
        },
      );

      return {
        success: true,
        message: '얼굴 인식 결제가 완료되었습니다.',
        orderId,
        user: {
          id: user.id,
          nickname: user.nickname,
        },
        card: {
          cardCompany: mainCard.cardCompany,
          cardNumber: mainCard.cardNumber,
        },
        payment: {
          amount: dto.amount,
          orderName: dto.orderName,
          paymentKey: paymentData.paymentKey,
        },
        confidence: recognitionResult.confidence,
      };
    } catch (error) {
      await this.paymentRepo.update(
        { orderId },
        { status: PaymentStatus.FAILED },
      );

      if (error instanceof NotFoundException) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data as TossErrorResponse;
        const errorMessage =
          errorData?.message || '결제 처리 중 오류가 발생했습니다.';
        console.error(
          '얼굴 인식 결제 오류:',
          error.response?.data || error.message,
        );
        throw new InternalServerErrorException(`결제 실패: ${errorMessage}`);
      }
      throw new InternalServerErrorException(
        '결제 처리 중 시스템 오류가 발생했습니다.',
      );
    }
  }

  async getPaymentHistory(userId: number) {
    const payments = await this.paymentRepo.find({
      where: { userId, status: PaymentStatus.SUCCESS },
      relations: ['card'],
      order: { createdAt: 'DESC' },
    });

    return payments.map((payment) => ({
      id: payment.id,
      orderId: payment.orderId,
      amount: payment.amount,
      orderName: payment.orderName,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      card: {
        cardCompany: payment.card.cardCompany,
        cardNumber: payment.card.cardNumber,
      },
      createdAt: payment.createdAt,
    }));
  }

  async registerFaceBase64(userId: number, base64Image: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    if (!base64Image) {
      throw new BadRequestException('이미지 데이터가 제공되지 않았습니다.');
    }

    const base64Data = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');
    const uploadsDir = path.join(process.cwd(), 'uploads', 'faces');
    await fs.ensureDir(uploadsDir);

    const filename = `user_${userId}_${Date.now()}.jpg`;
    const imagePath = path.join(uploadsDir, filename);

    try {
      const imageBuffer = Buffer.from(base64Data, 'base64');
      await fs.writeFile(imagePath, imageBuffer);

      const pythonScript = path.join(process.cwd(), 'public', 'face_api.py');
      const command = `python3 "${pythonScript}" register "${imagePath}" ${userId}`;
      const { stdout } = await execAsync(command);
      const result = JSON.parse(stdout) as {
        success: boolean;
        message: string;
        encoding?: string;
        error_code?: number;
      };

      if (result.success && result.encoding) {
        user.faceImagePath = imagePath;
        user.faceEncoding = result.encoding;
        await this.userRepo.save(user);

        return {
          success: true,
          message: '얼굴 등록이 완료되었습니다.',
          userId: userId,
        };
      } else {
        if (result.error_code === 404) {
          throw new NotFoundException(result.message);
        } else if (result.error_code === 400) {
          throw new BadRequestException(result.message);
        } else if (result.error_code === 500) {
          throw new InternalServerErrorException(result.message);
        } else {
          throw new Error(result.message);
        }
      }
    } catch (error: unknown) {
      await fs.remove(imagePath);

      if (error instanceof NotFoundException) {
        throw error;
      } else if (error instanceof BadRequestException) {
        throw error;
      } else if (error instanceof InternalServerErrorException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `얼굴 등록 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async recognizeFaceBase64(base64Image: string) {
    if (!base64Image) {
      throw new BadRequestException('이미지 데이터가 제공되지 않았습니다.');
    }

    const base64Data = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');

    const tempDir = path.join(process.cwd(), 'uploads', 'temp');
    await fs.ensureDir(tempDir);

    const filename = `temp_${Date.now()}.jpg`;
    const imagePath = path.join(tempDir, filename);

    try {
      const imageBuffer = Buffer.from(base64Data, 'base64');
      await fs.writeFile(imagePath, imageBuffer);

      const users = await this.userRepo.find({
        where: { faceEncoding: Not(IsNull()) },
      });

      if (users.length === 0) {
        throw new NotFoundException('등록된 얼굴이 없습니다.');
      }

      const faceData = users.map((user) => ({
        userId: user.id,
        encoding: user.faceEncoding,
      }));

      const pythonScript = path.join(process.cwd(), 'public', 'face_api.py');
      const command = `python3 "${pythonScript}" recognize "${imagePath}" '${JSON.stringify(faceData)}'`;

      const { stdout } = await execAsync(command);
      const result = JSON.parse(stdout) as {
        success: boolean;
        message: string;
        userId?: number;
        confidence?: number;
        error_code?: number;
      };

      await fs.remove(imagePath);

      if (result.success && result.userId) {
        const recognizedUser = await this.userRepo.findOne({
          where: { id: result.userId },
        });

        return {
          success: true,
          message: '얼굴 인식 성공',
          user: recognizedUser,
          confidence: result.confidence,
        };
      } else {
        if (result.error_code === 404) {
          throw new NotFoundException(result.message);
        } else if (result.error_code === 400) {
          throw new BadRequestException(result.message);
        } else if (result.error_code === 500) {
          throw new InternalServerErrorException(result.message);
        } else {
          throw new Error(result.message);
        }
      }
    } catch (error: unknown) {
      await fs.remove(imagePath);

      if (error instanceof NotFoundException) {
        throw error;
      } else if (error instanceof BadRequestException) {
        throw error;
      } else if (error instanceof InternalServerErrorException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `얼굴 인식 실패: ${String(error)}`,
      );
    }
  }

  async verifyPin(userId: number, pin: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    const isMatch = await bcrypt.compare(pin, user.pin);
    if (!isMatch) {
      throw new BadRequestException('PIN이 일치하지 않습니다.');
    }

    return { success: true, message: 'PIN이 확인되었습니다.' };
  }

  async updatePin(userId: number, currentPin: string, newPin: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    const isMatch = await bcrypt.compare(currentPin, user.pin);
    if (!isMatch) {
      throw new BadRequestException('현재 PIN이 일치하지 않습니다.');
    }

    const hashedNewPin = await bcrypt.hash(newPin, 10);
    user.pin = hashedNewPin;
    await this.userRepo.save(user);

    return { success: true, message: 'PIN이 성공적으로 변경되었습니다.' };
  }
}
