import { useEffect, useRef, useState } from 'react';
import { customAvatarStates, preloadCustomerAvatar } from './customerAvatarUtils';

export type CustomerAvatarPickerTheme = 'orange' | 'emerald';
export type CustomerAvatarPickerVariant = 'regular' | 'vip';

interface AvatarOption {
  emoji: string;
  label: string;
}

interface CustomerAvatarPickerProps {
  value: string;
  onChange: (avatar: string) => void;
  theme: CustomerAvatarPickerTheme;
  variant: CustomerAvatarPickerVariant;
  size?: 'compact' | 'large';
}

const regularAvatarOptions: AvatarOption[] = [
  { emoji: '🧑', label: '經典' },
  { emoji: '👨', label: '現代' },
  { emoji: '👩', label: '現代女士' },
  { emoji: '🧒', label: '年輕' },
  { emoji: '👦', label: '朝氣' },
  { emoji: '👧', label: '朝氣女士' },
  { emoji: '👴', label: '優雅' },
  { emoji: '👵', label: '優雅女士' },
  { emoji: '👨‍💼', label: '商務' },
  { emoji: '👩‍💼', label: '商務女士' },
  { emoji: '👨‍🔧', label: '工匠' },
  { emoji: '👩‍🔧', label: '工匠女士' },
  { emoji: '👨‍⚕️', label: '照護者' },
  { emoji: '👩‍⚕️', label: '照護者女士' },
  { emoji: '👨‍🎓', label: '學者' },
  { emoji: '👩‍🎓', label: '學者女士' },
  { emoji: '👨‍🏫', label: '導師' },
  { emoji: '👩‍🏫', label: '導師女士' },
  { emoji: '👨‍🌾', label: '園藝家' },
  { emoji: '👩‍🌾', label: '園藝家女士' },
  { emoji: '👨‍🍳', label: '主廚' },
  { emoji: '👩‍🍳', label: '主廚女士' },
  { emoji: '👨‍🎨', label: '藝術家' },
  { emoji: '👩‍🎨', label: '藝術家女士' },
  { emoji: '👨‍💻', label: '創作者' },
  { emoji: '👩‍💻', label: '創作者女士' },
  { emoji: '🦸‍♂️', label: '守護者' },
  { emoji: '🦸‍♀️', label: '守護者女士' },
  { emoji: '🧙‍♂️', label: '神秘使者' },
  { emoji: '🧙‍♀️', label: '神秘使者女士' },
  { emoji: '🧚‍♂️', label: '夢想家' },
  { emoji: '🧚‍♀️', label: '夢想家女士' },
  { emoji: '🧛‍♂️', label: '暮夜' },
  { emoji: '🧛‍♀️', label: '暮夜女士' },
  { emoji: '🧜‍♂️', label: '海洋' },
  { emoji: '🧜‍♀️', label: '海洋女士' },
  { emoji: '🧝‍♂️', label: '漫遊者' },
  { emoji: '🧝‍♀️', label: '漫遊者女士' },
  { emoji: '👼', label: '寧靜' },
  { emoji: '🤴', label: '尊貴' },
  { emoji: '👸', label: '尊貴女士' },
  { emoji: '🤵', label: '正式' },
  { emoji: '👰', label: '正式女士' },
  { emoji: '🤶', label: '冬日' },
  { emoji: '🎅', label: '節慶' },
  { emoji: '🤠', label: '開拓者' },
  { emoji: '🥷', label: '暗影' },
  { emoji: '👮', label: '保衛者' },
  { emoji: '🕵️', label: '觀察者' },
  { emoji: '💂', label: '哨兵' },
];

const vipAvatarOptions: AvatarOption[] = [
  { emoji: '👨‍💼', label: '黃金商務' },
  { emoji: '👩‍💼', label: '黃金商務女士' },
  { emoji: '🧑‍💼', label: '白金商務' },
  { emoji: '👨‍🎓', label: '鑽石學者' },
  { emoji: '👩‍🎓', label: '鑽石學者女士' },
  { emoji: '🧑‍🎓', label: '白金學者' },
  { emoji: '👨‍⚖️', label: '皇冠顧問' },
  { emoji: '👩‍⚖️', label: '皇冠顧問女士' },
  { emoji: '🧑‍⚖️', label: '皇室顧問' },
  { emoji: '👨‍🔬', label: '稜鏡科學家' },
  { emoji: '👩‍🔬', label: '稜鏡科學家女士' },
  { emoji: '🧑‍🔬', label: '稜鏡研究員' },
  { emoji: '🤵', label: '天鵝絨正式' },
  { emoji: '🤵‍♂️', label: '天鵝絨尊貴正式' },
  { emoji: '🤵‍♀️', label: '天鵝絨正式女士' },
  { emoji: '👰', label: '珍珠正式' },
  { emoji: '👰‍♂️', label: '珍珠尊貴正式' },
  { emoji: '👰‍♀️', label: '珍珠正式女士' },
  { emoji: '🤴', label: '皇室繼承人' },
  { emoji: '👸', label: '皇室女繼承人' },
  { emoji: '🦸‍♂️', label: '巔峰守護者' },
  { emoji: '🦸‍♀️', label: '巔峰守護者女士' },
  { emoji: '🦸', label: '巔峰冠軍' },
  { emoji: '🧙‍♂️', label: '秘法大師' },
  { emoji: '🧙‍♀️', label: '秘法大師女士' },
  { emoji: '🧙', label: '秘法賢者' },
  { emoji: '🧚‍♂️', label: '星光守護者' },
  { emoji: '🧚‍♀️', label: '星光守護者女士' },
  { emoji: '🧚', label: '星光精靈' },
  { emoji: '🧛‍♂️', label: '黑曜貴族' },
  { emoji: '🧛‍♀️', label: '黑曜貴族女士' },
  { emoji: '🧛', label: '黑曜君主' },
];

function getAvatarBackground(index: number, vip: boolean): [string, string] {
  const businessHues = [204, 214, 198, 188, 221, 158, 38, 20, 232, 194, 46, 208];
  const goldHues = [32, 36, 40, 44, 47, 38, 29, 42, 49, 34, 45, 52];
  const palette = vip ? goldHues : businessHues;
  const hue = palette[(index * 7 + (vip ? 3 : 0)) % palette.length];
  const accentHue = vip
    ? hue + (index % 3 === 0 ? 3 : index % 3 === 1 ? 7 : -3)
    : (hue + (index % 3 === 0 ? 18 : 9)) % 360;
  const baseLightness = vip ? 48 + (index % 4) * 4 : 58 + (index % 4) * 2;
  const accentLightness = vip ? 74 + (index % 4) * 4 : 76 + (index % 3) * 3;
  const saturation = vip ? 58 : 34;
  const accentSaturation = vip ? 64 : 42;

  return [
    `hsl(${hue} ${saturation}% ${baseLightness}%)`,
    `hsl(${accentHue} ${accentSaturation}% ${Math.min(accentLightness, 90)}%)`,
  ];
}

const skinTones = ['#f8d4b8', '#f5c5a3', '#f9ddc9', '#f6cfb5', '#efd0b5', '#e7b994', '#f3c8ae', '#d89a76', '#bf7959', '#f4c6a4'];
const hairTones = ['#17191c', '#241d1a', '#33251e', '#463126', '#5a3b2a', '#2d3034', '#3f3029', '#594338', '#6b4a35', '#292625'];
const jacketTones = ['#1f3042', '#2f4050', '#263746', '#3b4652', '#4a3c36', '#27434a', '#1f3550', '#51443d', '#2c3946', '#364655'];
const vipJacketTones = ['#30291f', '#3e3426', '#24374b', '#4a3428', '#25423f', '#3f3424', '#27364a', '#40364d', '#2d4841', '#49352d'];
const formalShirtTones = ['#f6f2e9', '#eaf0f2', '#dce7eb', '#f4eee2', '#dbe7e2', '#f8f5ee'];
const tieTones = ['#234c73', '#385d7a', '#536e8b', '#7a4a48', '#2e6664', '#675274', '#8b6848', '#3d5360'];

const faceShapes = [
  'M18 29c0-10 6-17 14-17s14 7 14 17c0 10-6 17-14 17S18 39 18 29Z',
  'M19 26c0-9 5-14 13-14s13 5 13 14c0 8-3 17-13 19-10-2-13-11-13-19Z',
  'M17 29c0-10 7-16 15-16s15 6 15 16c0 8-5 17-15 17S17 37 17 29Z',
  'M19 24c2-8 7-12 13-12s12 4 13 12c1 10-3 21-13 22-10-1-14-12-13-22Z',
  'M18 28c0-9 5-16 14-16s14 7 14 16c0 9-4 17-14 17S18 37 18 28Z',
  'M17 27c1-10 7-15 15-15s14 5 15 15c0 10-5 18-15 18s-15-8-15-18Z',
  'M18 27c0-10 6-15 14-15s14 5 14 15c0 11-5 18-14 18S18 38 18 27Z',
  'M20 26c0-8 4-14 12-14 9 0 13 6 13 14 0 9-4 18-13 18-8 0-12-9-12-18Z',
  'M17 28c1-9 6-16 15-16 8 0 14 7 15 16-1 10-6 17-15 17-10 0-14-7-15-17Z',
  'M19 25c1-8 6-13 13-13 8 0 13 5 14 13 1 10-4 20-14 20-9 0-14-10-13-20Z',
];

const vipFaceShapes = [
  'M17 28c0-10 6-16 15-16s15 6 15 16c0 10-5 18-15 18S17 38 17 28Z',
  'M19 25c1-8 6-13 13-13 9 0 14 6 14 14 0 11-5 19-14 19-8 0-14-9-13-20Z',
  'M16 29c1-10 7-17 16-17s16 7 16 17c-1 9-6 16-16 16S17 38 16 29Z',
  'M18 26c0-9 5-14 14-14s14 6 14 14c0 10-4 19-14 20-9-1-14-10-14-20Z',
  'M17 27c1-9 6-15 15-15s15 6 15 15c0 11-6 18-15 18S17 38 17 27Z',
  'M20 25c0-8 4-13 12-13 9 0 14 6 14 14 0 10-5 18-14 18-8 0-12-9-12-19Z',
];

const hairStyles = [
  'M15 31C13 17 20 8 32 8s19 9 17 23c-3-5-6-7-10-8-5 6-13 8-24 8Z',
  'M14 31C13 17 21 8 32 8c11 0 19 8 18 23l-5 3-2-14c-8 5-16 6-26 4l-1 12Z',
  'M15 27C16 14 23 8 33 8c11 0 17 8 17 20-3-5-6-7-8-8-4 4-11 7-24 7Z',
  'M16 29C14 16 21 7 33 7c12 0 18 9 16 23l-4-4-2-10c-7 3-15 4-25 2l-1 11Z',
  'M14 29C14 15 23 7 34 7c8 0 14 5 16 13-8-3-15-2-23 2-3 2-7 4-13 7Z',
  'M15 30C12 26 13 18 17 14c0-5 5-8 9-6 3-4 10-4 12 0 5-2 10 2 10 7 5 3 6 10 3 15-4-5-8-7-12-8-6 5-14 8-24 8Z',
  'M14 30C11 24 13 14 19 10c3-5 10-5 13-1 4-4 11-2 12 3 6 2 8 9 6 15-4-5-8-7-12-8-6 5-14 8-24 8Z',
  'M15 28c0-11 6-18 17-20 8 2 14 7 16 16-5-2-10-3-15-1-5 2-10 4-18 5Z',
  'M15 31C13 17 19 8 31 8c12 0 20 9 18 23l-5 2-3-12-3 6-5-7-4 7-6-4-2 11Z',
  'M15 29C14 17 22 9 32 8c10 0 18 7 18 19-4-2-7-6-8-11-6 4-14 7-27 7Z',
];

const femaleBackHairStyles = [
  'M13 49C10 37 11 19 19 10 26 3 39 4 47 12c7 8 8 23 3 37l-8-3-2-19c-6 4-13 5-20 2l-1 20Z',
  'M12 48C9 34 12 17 21 9c7-6 19-6 27 2 7 8 7 23 4 37l-8-3-1-18c-6 3-14 4-22 1l-2 20Z',
  'M14 50C10 36 12 19 20 11 27 4 39 4 47 11c8 8 8 23 4 39l-7-4-2-20c-6 4-13 5-20 2l-1 22Z',
  'M12 47C10 32 14 16 23 9c8-6 19-4 26 4 6 8 6 21 3 35l-8-3-1-18c-6 3-13 4-21 1l-2 19Z',
  'M11 48C9 35 12 18 22 9c8-7 20-5 27 4 6 8 6 23 2 37l-8-4-2-21c-6 4-13 5-21 2l-1 21Z',
  'M14 50C9 39 10 20 18 11c7-8 20-8 28 0 8 9 9 27 4 40l-8-4-2-21c-5 4-13 6-22 2l-1 22Z',
  'M12 49C8 38 10 20 19 10c7-8 20-9 28-2 7 7 9 20 5 39l-8-4-2-20c-6 4-13 5-21 2l-1 24Z',
  'M11 47C7 36 10 18 20 9c8-7 21-6 29 3 6 8 7 22 3 37l-9-4-1-20c-6 4-14 5-22 2l-1 20Z',
  'M12 47C8 41 10 31 12 25c-2-8 4-16 11-15 4-7 14-8 19-2 8 0 13 8 10 15 5 7 4 17 0 25l-8-3-2-20c-6 4-13 5-21 2l-1 20Z',
  'M16 50C12 37 13 18 21 10c-2-6 3-10 9-8 3-5 11-5 14 0 6-1 10 4 8 9 6 10 5 27 1 39l-8-4-2-20c-6 4-13 5-21 2l-1 22Z',
];

const femaleHairStyles = [
  'M15 27C16 14 23 8 33 8c11 0 18 8 17 19-4-4-7-7-9-12-6 5-14 8-26 7Z',
  'M14 29C14 16 22 8 33 8c10 0 17 7 18 19-5-3-8-7-10-12-6 5-14 8-27 7Z',
  'M15 26C17 14 24 8 33 8c10 0 17 7 17 19-4-3-7-7-9-12-5 5-14 8-26 7Z',
  'M16 28C15 15 22 7 33 7c11 0 18 8 16 21-4-4-7-8-9-13-6 5-13 8-24 8Z',
  'M14 28C15 15 23 7 33 7c10 0 17 7 18 20-5-4-8-8-10-14-6 5-14 8-27 8Z',
  'M15 29C15 16 21 8 32 8c11 0 18 8 18 20-4-3-8-7-10-12-6 5-14 8-25 7Z',
  'M14 29C14 16 21 8 32 8c10 0 18 8 18 21-5-5-8-8-10-13-5 6-14 8-26 7Z',
  'M15 28C16 14 24 7 34 8c8 1 15 7 16 16-5-3-9-7-12-13-5 5-12 8-23 8Z',
  'M14 28C14 15 23 7 33 7c11 0 17 8 17 21-3-6-7-10-11-13-3 5-13 10-25 10Z',
  'M15 29C15 16 21 8 32 8c11 0 18 8 18 20-4-3-8-7-10-12-6 5-14 8-25 7Z',
];

const vipHairStyles = [
  'M14 29C14 16 22 7 33 7c10 0 18 7 18 20-5-2-8-5-10-9-6 3-14 5-26 4l-1 7Z',
  'M15 28C15 14 24 7 34 8c9 1 15 7 16 17-4-1-8-4-10-8-6 4-14 6-25 5Z',
  'M14 30C12 18 19 8 31 7c12-1 20 8 19 21-4-4-7-7-9-11-5 3-14 5-27 4Z',
  'M16 28C15 15 22 8 33 7c10 0 18 7 18 19-4-2-8-5-11-10-5 4-13 6-24 6Z',
  'M14 30C13 17 21 8 32 8c12 0 19 8 18 20-4-3-8-6-11-11-6 5-14 7-25 6Z',
  'M15 27C16 14 24 7 34 8c10 1 17 8 16 19-5-2-9-5-12-10-5 4-13 6-23 6Z',
  'M13 29C13 16 20 8 31 7c12-1 20 8 19 21-4-5-8-8-11-12-5 4-14 7-26 7Z',
  'M15 29C14 16 23 7 33 7c11 0 18 8 18 20-5-3-9-7-11-12-6 4-14 7-25 7Z',
];

const vipFemaleHairStyles = [
  'M14 29C14 15 22 7 33 7c11 0 19 8 18 20-4-3-8-7-10-12-6 5-14 7-27 7Z',
  'M15 28C16 14 24 7 34 8c9 1 16 7 16 18-4-2-8-6-11-12-5 5-13 7-24 7Z',
  'M14 30C14 16 23 7 33 7c11 0 18 8 18 20-5-4-8-8-10-13-6 5-14 8-27 8Z',
  'M15 28C15 15 23 8 33 8c10 0 18 7 18 19-5-3-9-7-11-12-5 5-13 8-25 8Z',
  'M13 29C13 15 22 7 33 7c11 0 20 8 18 21-5-4-9-8-11-13-6 5-14 8-27 8Z',
  'M15 27C16 14 24 7 34 8c10 1 17 8 16 19-5-3-9-7-11-12-6 5-13 7-24 7Z',
  'M14 30C14 16 23 7 33 7c11 0 19 8 18 20-4-4-8-8-10-13-6 4-14 8-27 8Z',
  'M16 28C15 15 22 8 33 8c10 0 18 7 18 19-4-2-8-6-11-11-5 5-13 8-24 8Z',
];

const vipBodyStyles = [
  'M5 63c3-14 12-21 27-21s24 7 27 21',
  'M7 63c2-12 11-20 25-20s23 8 25 20',
  'M5 63c4-13 13-21 27-21s24 8 27 21',
  'M6 63c3-15 13-22 26-22s23 7 26 22',
];

const mouthStyles = [
  'M29 36c2 1.5 4 1.5 6 0',
  'M28 36c2 2 6 2 8 0',
  'M29 36c2 1 4 1 6 0',
  'M28 35c2 2 6 2 8 0',
];

const bodyStyles = [
  'M8 63c2-11 10-18 24-18s22 7 24 18',
  'M6 63c3-13 13-20 26-20s23 7 26 20',
  'M10 63c0-10 8-17 22-17s21 7 22 17',
  'M7 63c3-9 11-16 25-16s23 7 25 17',
  'M9 63c4-14 12-20 23-20s20 6 23 20',
  'M5 63c4-11 13-18 27-18s23 7 27 18',
];

const themeStyles: Record<CustomerAvatarPickerTheme, {
  panel: string;
  idle: string;
  selected: string;
  accent: string;
}> = {
  orange: {
    panel: 'border-orange-200/35 bg-gradient-to-br from-orange-100/15 via-white/10 to-amber-100/15',
    idle: 'border-orange-100/35 bg-white/10 hover:border-orange-50/90 hover:bg-orange-50/20',
    selected: 'border-orange-50 bg-orange-50/25 ring-2 ring-orange-100/90 shadow-lg shadow-orange-200/30',
    accent: 'text-orange-50',
  },
  emerald: {
    panel: 'border-emerald-200/35 bg-gradient-to-br from-emerald-100/15 via-white/10 to-teal-100/15',
    idle: 'border-emerald-100/35 bg-white/10 hover:border-emerald-50/90 hover:bg-emerald-50/20',
    selected: 'border-emerald-50 bg-emerald-50/25 ring-2 ring-emerald-100/90 shadow-lg shadow-emerald-200/30',
    accent: 'text-emerald-50',
  },
};

function AvatarArtwork({ index, vip }: { index: number; vip: boolean }) {
  const featureSeed = index * 7 + (vip ? 29 : 11);
  const [backgroundStart, backgroundEnd] = getAvatarBackground(index, vip);
  const skin = skinTones[(featureSeed * 7 + 2) % skinTones.length];
  const hair = hairTones[(featureSeed * 11 + (vip ? 2 : 0)) % hairTones.length];
  const isFemale = index % 2 === 0;
  const hairOptions = vip
    ? isFemale
      ? vipFemaleHairStyles
      : vipHairStyles
    : isFemale
      ? femaleHairStyles
      : hairStyles;
  const hairStyle = hairOptions[(featureSeed * 3 + 1) % hairOptions.length];
  const facePalette = vip ? vipFaceShapes : faceShapes;
  const faceShape = facePalette[(featureSeed * 5 + (vip ? 1 : 0)) % facePalette.length];
  const jacketPalette = vip ? vipJacketTones : jacketTones;
  const jacket = jacketPalette[(featureSeed * 13 + 4) % jacketPalette.length];
  const shirt = formalShirtTones[(featureSeed * 17 + 2) % formalShirtTones.length];
  const eyeVariant = (featureSeed * 5) % 4;
  const browVariant = (featureSeed * 3) % 3;
  const noseVariant = (featureSeed * 11) % 3;
  const hasGlasses = featureSeed % 8 === 1 || (vip && featureSeed % 9 === 0);
  const hasEarring = featureSeed % 5 === 2 || (isFemale && featureSeed % 8 === 0);
  const hasHairHighlight = featureSeed % 4 === 0;
  const hasNecklace = isFemale && featureSeed % 5 === 2;
  const hasTie = !isFemale;
  const hasPremiumLapels = vip;
  const hasPremiumPin = vip && featureSeed % 3 !== 2;
  const hasPremiumNecklace = vip && isFemale;
  const hasFacialHair = !isFemale && featureSeed % 6 === 1;
  const hasFreckles = featureSeed % 11 === 3;
  const mouthStyle = mouthStyles[(featureSeed * 7 + 2) % mouthStyles.length];
  const bodyPalette = vip ? vipBodyStyles : bodyStyles;
  const bodyStyle = bodyPalette[(featureSeed * 13 + 1) % bodyPalette.length];
  const tie = tieTones[(featureSeed * 5 + 1) % tieTones.length];
  const earringColor = ['#bda66b', '#9fb6ad', '#b88c9c', '#9aaec2'][featureSeed % 4];
  const ageDetail = featureSeed % 5;
  const portraitTilt = [-2, -1, 0, 1, 2][featureSeed % 5];
  const portraitShift = [-0.5, -0.25, 0, 0.25, 0.5][(featureSeed * 3) % 5];

  return (
    <div
      className="relative block h-full w-full overflow-hidden"
      style={{ background: `linear-gradient(145deg, ${backgroundStart} 0%, ${backgroundEnd} 100%)` }}
    >
      {vip && <div className="absolute inset-0 bg-gradient-to-br from-yellow-100/20 via-amber-200/10 to-amber-950/18" />}
      <svg viewBox="0 0 64 64" className="relative block h-full w-full" aria-hidden="true">
        <g transform={`translate(${portraitShift} 0) rotate(${portraitTilt} 32 34)`}>
        <path d={bodyStyle} fill={jacket} />
        <path d="M24 44h16v10H24z" fill={skin} />
        <path d="M20 52l12 8 12-8 4 11H16z" fill={jacket} opacity=".96" />
        <path d="M25 48l7 7 7-7 4 2-4 10H25l-4-10z" fill={shirt} opacity=".96" />
        <path d="M20 51l12 9 12-9" fill="none" stroke={vip ? '#e8cc7b' : '#b7c5ce'} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.15" opacity=".95" />
        {hasTie && (
          <>
            <path d="M29 51h6l2 10H27z" fill={tie} />
            <path d="M29 51l3 4 3-4" fill="none" stroke="#f4d989" strokeWidth="1" />
            {vip && <path d="M30 57h4" fill="none" stroke="#f8df96" strokeLinecap="round" strokeWidth=".8" />}
          </>
        )}
        {hasPremiumLapels && <path d="M22 52l10 8 10-8" fill="none" stroke="#f1d889" strokeLinecap="round" strokeLinejoin="round" strokeWidth=".75" opacity=".9" />}
        {hasPremiumPin && <circle cx="43" cy="55" r="1.25" fill="#f4d989" stroke="#8b6b2d" strokeWidth=".45" />}
        {hasPremiumNecklace && <path d="M24 47c3 4 13 4 16 0M31 50.5h2" fill="none" stroke="#f4d989" strokeLinecap="round" strokeWidth="1.1" />}
        {isFemale && <path d={femaleBackHairStyles[(featureSeed * 17) % femaleBackHairStyles.length]} fill={hair} />}
        <circle cx="17" cy="30" r="3.5" fill={skin} />
        <circle cx="47" cy="30" r="3.5" fill={skin} />
        <path d={faceShape} fill={skin} />
        <path d={hairStyle} fill={hair} />
        {browVariant === 0 && <path d="M22 26c2-1.5 4-1.5 6-.2M36 25.8c2-1.3 4-1.3 6 .2" fill="none" stroke="#3b2730" strokeLinecap="round" strokeWidth="1.5" />}
        {browVariant === 1 && <path d="M22 25.5c2-1 4-1 6 .4M36 25.9c2-1.4 4-1.4 6-.4" fill="none" stroke="#3b2730" strokeLinecap="round" strokeWidth="1.5" />}
        {browVariant === 2 && <path d="M22 26.2c2-.4 4-.4 6 .5M36 26.7c2-.9 4-.9 6-.5" fill="none" stroke="#3b2730" strokeLinecap="round" strokeWidth="1.5" />}
        {eyeVariant === 0 && (
          <>
            <circle cx="26" cy="30" r="1.3" fill="#1f1720" />
            <circle cx="38" cy="30" r="1.3" fill="#1f1720" />
          </>
        )}
        {eyeVariant === 1 && (
          <>
            <ellipse cx="26" cy="30" rx="1.8" ry="1.1" fill="#1f1720" />
            <ellipse cx="38" cy="30" rx="1.8" ry="1.1" fill="#1f1720" />
          </>
        )}
        {eyeVariant === 2 && (
          <>
            <path d="M24.5 30c.8-1.4 2.2-1.4 3 0M36.5 30c.8-1.4 2.2-1.4 3 0" fill="none" stroke="#1f1720" strokeLinecap="round" strokeWidth="1.5" />
            <circle cx="26" cy="30" r=".65" fill="#1f1720" />
            <circle cx="38" cy="30" r=".65" fill="#1f1720" />
          </>
        )}
        {eyeVariant === 3 && (
          <>
            <ellipse cx="26" cy="30" rx="1.45" ry="1.25" fill="#1f1720" />
            <ellipse cx="38" cy="30" rx="1.45" ry="1.25" fill="#1f1720" />
            <circle cx="25.65" cy="29.65" r=".35" fill="#fff" />
            <circle cx="37.65" cy="29.65" r=".35" fill="#fff" />
          </>
        )}
        {noseVariant === 0 && <path d="M32 30.5v3l-1.5 1" fill="none" stroke="#b87563" strokeLinecap="round" strokeWidth="1" />}
        {noseVariant === 1 && <path d="M31 30l-.5 4 2 1" fill="none" stroke="#b87563" strokeLinecap="round" strokeWidth="1" />}
        {noseVariant === 2 && <path d="M32 30.5v3.2" fill="none" stroke="#b87563" strokeLinecap="round" strokeWidth="1" />}
        {ageDetail !== 4 && <path d="M23 34c-1.5 1-2.5 2-3 3M41 34c1.5 1 2.5 2 3 3" fill="none" stroke="#a96f61" strokeLinecap="round" strokeWidth=".85" opacity=".58" />}
        {ageDetail === 0 && <path d="M25 19c2-1 4-1 6-.5M33 18.5c2-.5 4-.5 6 .5" fill="none" stroke="#a96f61" strokeLinecap="round" strokeWidth=".8" opacity=".5" />}
        {ageDetail === 1 && <path d="M23 32c-1.5 1-2 2-2.5 3M41 32c1.5 1 2 2 2.5 3" fill="none" stroke="#a96f61" strokeLinecap="round" strokeWidth=".8" opacity=".55" />}
        {ageDetail === 2 && <path d="M24 35c-1.5 1-2 2-2.5 3M40 35c1.5 1 2 2 2.5 3" fill="none" stroke="#a96f61" strokeLinecap="round" strokeWidth=".8" opacity=".52" />}
        <path d={mouthStyle} fill="none" stroke={isFemale ? '#a55567' : '#885048'} strokeLinecap="round" strokeWidth="1.4" />
        {hasFreckles && (
          <>
            <circle cx="23" cy="35" r=".8" fill="#a9654c" opacity=".7" />
            <circle cx="25.5" cy="36" r=".7" fill="#a9654c" opacity=".7" />
            <circle cx="39" cy="36" r=".7" fill="#a9654c" opacity=".7" />
            <circle cx="41" cy="35" r=".8" fill="#a9654c" opacity=".7" />
          </>
        )}
        {hasFacialHair && <path d="M25 37c1 5 4 7 7 7s6-2 7-7c-3 1.5-11 1.5-14 0Z" fill={hair} opacity=".58" />}
        {!isFemale && featureSeed % 5 === 2 && <path d="M27 36c1.5 1 8.5 1 10 0" fill="none" stroke={hair} strokeLinecap="round" strokeWidth="1.4" opacity=".58" />}
        {hasHairHighlight && <path d="M20 17c3-4 7-6 12-7" fill="none" stroke="#d9cdbd" strokeLinecap="round" strokeWidth="1.2" opacity=".5" />}
        {hasNecklace && (
          <>
            <path d="M24 47c3 4 13 4 16 0" fill="none" stroke="#f8d978" strokeLinecap="round" strokeWidth="1.1" />
            <circle cx="32" cy="51" r="1.8" fill="#f8d978" />
          </>
        )}
        {hasGlasses && (
          <g fill="none" stroke={vip ? '#8a6a32' : '#40566b'} strokeWidth="1.2">
            <rect x="20" y="27" width="10" height="7" rx="3" />
            <rect x="34" y="27" width="10" height="7" rx="3" />
            <path d="M30 29h4" />
          </g>
        )}
        {hasEarring && (
          <>
            <circle cx="18" cy="35" r="1.4" fill={earringColor} />
            <circle cx="46" cy="35" r="1.4" fill={earringColor} />
          </>
        )}
        </g>
      </svg>
    </div>
  );
}

export interface CustomerAvatarDisplayProps {
  avatar?: string | null;
  isVip?: boolean;
  customAvatarUrl?: string | null;
  alt?: string;
  className?: string;
}

const avatarKeyPattern = /^customer-avatar:(regular|vip):(\d+)$/;
type AvatarCollection = 'regular' | 'vip';

function getAvatarKey(collection: AvatarCollection, index: number) {
  return `customer-avatar:${collection}:${index}`;
}

function getAvatarIndex(avatar: string | null | undefined, collection: AvatarCollection) {
  const match = avatar?.match(avatarKeyPattern);
  if (match && match[1] === collection) {
    const index = Number(match[2]);
    const options = collection === 'vip' ? vipAvatarOptions : regularAvatarOptions;
    if (index >= 0 && index < options.length) return index;
  }

  const preferredOptions = collection === 'vip' ? vipAvatarOptions : regularAvatarOptions;
  const preferredIndex = preferredOptions.findIndex((option) => option.emoji === avatar);
  if (preferredIndex >= 0) return preferredIndex;

  const fallbackIndex = regularAvatarOptions.findIndex((option) => option.emoji === avatar);
  return fallbackIndex >= 0 ? fallbackIndex : 0;
}

export function CustomerAvatarDisplay({
  avatar,
  isVip = false,
  customAvatarUrl,
  alt = '客戶頭像',
  className = 'h-10 w-10 rounded-full',
}: CustomerAvatarDisplayProps) {
  const normalizedCustomAvatarUrl = customAvatarUrl?.trim() || null;
  const [imageError, setImageError] = useState(false);
  const [imageReady, setImageReady] = useState(
    () => Boolean(normalizedCustomAvatarUrl && customAvatarStates.get(normalizedCustomAvatarUrl) === 'loaded'),
  );
  const imageRef = useRef<HTMLImageElement>(null);
  const avatarIndex = getAvatarIndex(avatar, isVip ? 'vip' : 'regular');

  useEffect(() => {
    let cancelled = false;
    setImageError(false);

    if (!normalizedCustomAvatarUrl) {
      setImageReady(false);
      return;
    }

    const state = customAvatarStates.get(normalizedCustomAvatarUrl);
    if (state === 'loaded') {
      setImageReady(true);
      return;
    }
    if (state === 'error') {
      setImageReady(false);
      setImageError(true);
      return;
    }

    setImageReady(false);
    void preloadCustomerAvatar(normalizedCustomAvatarUrl).then((loaded) => {
      if (cancelled) return;
      setImageReady(loaded);
      setImageError(!loaded);
    });

    return () => {
      cancelled = true;
    };
  }, [normalizedCustomAvatarUrl]);

  const imageIsCached = Boolean(
    normalizedCustomAvatarUrl &&
    customAvatarStates.get(normalizedCustomAvatarUrl) === 'loaded',
  );
  const imageIsVisible = imageReady || imageIsCached;
  const showFallbackArtwork = !normalizedCustomAvatarUrl || imageError || !imageIsVisible;

  return (
    <div className={`relative flex aspect-square min-h-0 min-w-0 items-center justify-center overflow-hidden box-border ${className}`}>
      {showFallbackArtwork && <AvatarArtwork index={avatarIndex} vip={isVip} />}
      {normalizedCustomAvatarUrl && !imageError && (
        <img
          ref={imageRef}
          key={normalizedCustomAvatarUrl}
          src={normalizedCustomAvatarUrl}
          alt={alt}
          className={`absolute inset-0 block h-full w-full object-cover transition-opacity duration-150 ${imageIsVisible ? 'opacity-100' : 'opacity-0'}`}
          loading="eager"
          decoding="async"
          onLoad={() => {
            if (normalizedCustomAvatarUrl) customAvatarStates.set(normalizedCustomAvatarUrl, 'loaded');
            setImageReady(true);
            setImageError(false);
          }}
          onError={() => {
            if (normalizedCustomAvatarUrl) customAvatarStates.set(normalizedCustomAvatarUrl, 'error');
            setImageReady(false);
            setImageError(true);
          }}
        />
      )}
    </div>
  );
}

export default function CustomerAvatarPicker({ value, onChange, theme, variant, size = 'compact' }: CustomerAvatarPickerProps) {
  const collection: AvatarCollection = variant === 'vip' ? 'vip' : 'regular';
  const options = collection === 'vip' ? vipAvatarOptions : regularAvatarOptions;
  const styles = themeStyles[theme];
  const selectedIndex = getAvatarIndex(value, collection);
  const isStoredAvatarKey = value?.startsWith('customer-avatar:') ?? false;

  return (
    <div className={`rounded-2xl border shadow-inner shadow-black/15 ${size === 'large' ? 'p-1.5' : 'p-2.5'} ${variant === 'vip' ? 'border-amber-100/55 bg-gradient-to-br from-amber-100/25 via-white/10 to-yellow-100/20' : styles.panel}`}>
      <div className={`grid gap-1 ${variant === 'vip' ? (size === 'large' ? 'grid-cols-8' : 'grid-cols-6') : size === 'large' ? 'grid-cols-6 sm:grid-cols-8' : 'grid-cols-8 sm:grid-cols-10'}`}>
        {options.map((option, index) => {
          const optionValue = getAvatarKey(collection, index);
          const selected = value === optionValue || (!isStoredAvatarKey && selectedIndex === index);
          return (
            <button
              key={`${variant}-${option.emoji}-${index}`}
              type="button"
              title={option.label}
              aria-label={`選擇${option.label}頭像`}
              aria-pressed={selected}
              onClick={() => onChange(optionValue)}
              className={`group relative aspect-square min-w-0 overflow-hidden rounded-xl border p-0.5 transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.05] focus:outline-none focus:ring-2 focus:ring-white/80 ${selected ? (variant === 'vip' ? 'border-amber-50 bg-amber-50/35 ring-2 ring-amber-100/95 shadow-lg shadow-amber-200/35' : styles.selected) : (variant === 'vip' ? 'border-amber-50/45 bg-white/10 hover:border-amber-50/95 hover:bg-amber-50/25' : styles.idle)}`}
            >
              <AvatarArtwork index={index} vip={variant === 'vip'} />
              {selected && variant !== 'vip' && (
                <span className={`absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${theme === 'orange' ? 'bg-orange-50 shadow-[0_0_9px_rgba(255,237,213,1)]' : 'bg-emerald-50 shadow-[0_0_9px_rgba(209,250,229,1)]'}`} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
